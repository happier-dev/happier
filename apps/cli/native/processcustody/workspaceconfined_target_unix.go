//go:build linux || darwin

package main

import (
	"bufio"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/sys/unix"
)

// SYMLOOP_MAX bound for confined link-following (matches Linux MAXSYMLINKS = 40).
const workspaceTargetMaxLinkHops = 40

// Inline capture-leaf payload ceiling so huge binaries fall back to streaming reads instead of JSON blowup.
const workspaceTargetCaptureLeafMaxBytes uint64 = 32 * 1024 * 1024

// openWorkspaceTargetPath opens the handle chain for a root-relative path; "" is the root itself.
func openWorkspaceTargetPath(rootPath, relativePath string, missingAncestorAllowed bool) (*workspaceConfinedUnixPath, *workspaceConfinedDomainError) {
	return openWorkspaceTargetPathWithRoot(nil, rootPath, relativePath, missingAncestorAllowed)
}

func openWorkspaceTargetPathWithRoot(pinnedRoot *workspaceConfinedUnixHandle, rootPath, relativePath string, missingAncestorAllowed bool) (*workspaceConfinedUnixPath, *workspaceConfinedDomainError) {
	if relativePath != "" {
		return openWorkspaceConfinedUnixPathWithRoot(pinnedRoot, rootPath, relativePath, missingAncestorAllowed)
	}
	if pinnedRoot != nil {
		current, err := inspectWorkspaceConfinedUnixFD(pinnedRoot.fd)
		if err != nil || !workspaceTargetSameObject(current, *pinnedRoot) || current.kind != workspaceConfinedKindDirectory {
			return nil, workspaceConfinedError("workspace_root_unsafe", "workspace root could not be opened safely")
		}
		return newWorkspaceConfinedUnixRootPath(rootPath, current, pinnedRoot), nil
	}
	root, err := openWorkspaceConfinedUnixRoot(rootPath)
	if err != nil {
		return nil, workspaceConfinedError("workspace_root_unsafe", "workspace root could not be opened safely")
	}
	return newWorkspaceConfinedUnixRootPath(rootPath, root, nil), nil
}

// revalidateWorkspaceTargetPath re-walks the chain and requires the same identities (root-only chains too).
func revalidateWorkspaceTargetPath(path *workspaceConfinedUnixPath) *workspaceConfinedDomainError {
	if len(path.components) > 0 {
		return path.revalidate()
	}
	if path.pinnedRoot != nil {
		current, err := inspectWorkspaceConfinedUnixFD(path.pinnedRoot.fd)
		if err != nil || !workspaceTargetSameObject(current, path.handles[0]) || current.kind != workspaceConfinedKindDirectory {
			return workspaceConfinedError("conflict_changed", "workspace root changed before commit")
		}
		return nil
	}
	root, err := openWorkspaceConfinedUnixRoot(path.rootPath)
	if err != nil {
		return workspaceConfinedError("conflict_changed", "workspace root changed before commit")
	}
	defer unix.Close(root.fd)
	if !workspaceTargetSameObject(root, path.handles[0]) {
		return workspaceConfinedError("conflict_changed", "workspace root changed before commit")
	}
	return nil
}

func workspaceTargetDomainResult(err *workspaceConfinedDomainError) workspaceTargetResult {
	return workspaceTargetError(err.code, err.message)
}

func workspaceTargetEntryFromStat(kind workspaceConfinedKind, stat unix.Stat_t) *workspaceTargetEntry {
	return &workspaceTargetEntry{
		Kind:    string(kind),
		Size:    uint64(stat.Size),
		Mode:    uint32(stat.Mode),
		AtimeMs: float64(stat.Atim.Sec)*1e3 + float64(stat.Atim.Nsec)/1e6,
		MtimeMs: float64(stat.Mtim.Sec)*1e3 + float64(stat.Mtim.Nsec)/1e6,
		CtimeMs: float64(stat.Ctim.Sec)*1e3 + float64(stat.Ctim.Nsec)/1e6,
		Dev:     workspaceTargetStatDev(stat),
		Ino:     stat.Ino,
	}
}

func workspaceTargetEntryOf(handle workspaceConfinedUnixHandle) *workspaceTargetEntry {
	return workspaceTargetEntryFromStat(handle.kind, handle.stat)
}

func runWorkspaceTargetMeta(request workspaceTargetMetaRequest) workspaceTargetResult {
	return runWorkspaceTargetMetaWithRoot(nil, request)
}

func runWorkspaceTargetMetaWithRoot(pinnedRoot *workspaceConfinedUnixHandle, request workspaceTargetMetaRequest) workspaceTargetResult {
	if request.op == "capture-leaf" {
		result, _ := captureWorkspaceTargetLeafWithRoot(pinnedRoot, request.rootPath, request.relativePath, workspaceTargetCaptureLeafMaxBytes)
		return result
	}
	if request.op == "realpath" || request.op == "stat" || request.op == "access-executable" {
		resolved, domainErr, missing := resolveWorkspaceTargetRealpathWithRoot(pinnedRoot, request.rootPath, request.relativePath)
		if domainErr != nil {
			return workspaceTargetDomainResult(domainErr)
		}
		if missing {
			return workspaceTargetStatus("missing")
		}
		if request.op == "realpath" {
			result := workspaceTargetStatus("path")
			result.Path = &resolved
			return result
		}
		if request.op == "access-executable" {
			return accessWorkspaceTargetExecutableWithRoot(pinnedRoot, request.rootPath, resolved)
		}
		request = workspaceTargetMetaRequest{rootPath: request.rootPath, relativePath: resolved, op: "lstat"}
		result := runWorkspaceTargetMetaWithRoot(pinnedRoot, request)
		if result.Status == "entry" {
			result.Path = &resolved
		}
		return result
	}
	path, domainErr := openWorkspaceTargetPathWithRoot(pinnedRoot, request.rootPath, request.relativePath, true)
	if domainErr != nil {
		return workspaceTargetDomainResult(domainErr)
	}
	defer path.close()
	if path.isMissing() {
		return workspaceTargetStatus("missing")
	}
	final := path.final()
	switch request.op {
	case "lstat":
		result := workspaceTargetStatus("entry")
		result.Entry = workspaceTargetEntryOf(final)
		return result
	case "list":
		if final.kind != workspaceConfinedKindDirectory {
			return workspaceTargetError("not_directory", "workspace path is not a directory")
		}
		names, err := listWorkspaceConfinedUnixDirectory(final.fd)
		if err != nil {
			return workspaceTargetError("io_failed", "directory could not be listed")
		}
		entries := make([]workspaceTargetListEntry, 0, len(names))
		for _, name := range names {
			var stat unix.Stat_t
			if err := unix.Fstatat(final.fd, name, &stat, unix.AT_SYMLINK_NOFOLLOW); err != nil {
				continue // removed while listing
			}
			kind, err := workspaceConfinedUnixKind(uint32(stat.Mode))
			if err != nil {
				kind = "other"
			}
			entry := workspaceTargetListEntry{Name: name, Kind: string(kind)}
			switch kind {
			case workspaceConfinedKindSymlink:
				// Use the same confined stat as a single-file request. An escaping
				// or broken link is listed without the destination's metadata.
				result := runWorkspaceTargetMetaWithRoot(pinnedRoot, workspaceTargetMetaRequest{rootPath: request.rootPath,
					relativePath: filepath.Join(request.relativePath, name), op: "stat"})
				if result.Entry != nil {
					entry.Stats = &workspaceTargetListStats{Size: result.Entry.Size, MtimeMs: result.Entry.MtimeMs}
				}
			case workspaceConfinedKindDirectory, workspaceConfinedKindFile:
				statEntry := workspaceTargetEntryFromStat(kind, stat)
				entry.Stats = &workspaceTargetListStats{Size: statEntry.Size, MtimeMs: statEntry.MtimeMs}
			}
			entries = append(entries, entry)
		}
		result := workspaceTargetStatus("entries")
		result.Entries = entries
		return result
	case "readlink":
		if final.kind != workspaceConfinedKindSymlink || len(path.components) == 0 {
			return workspaceTargetError("not_link", "workspace path is not a symbolic link")
		}
		parent := path.handles[len(path.handles)-2]
		target, err := readlinkatString(parent.fd, path.components[len(path.components)-1])
		if err != nil {
			return workspaceTargetError("io_failed", "link could not be read")
		}
		result := workspaceTargetStatus("link")
		result.Target = &target
		return result
	}
	return workspaceTargetError("workspace_root_unsafe", "unknown op")
}

func captureWorkspaceTargetLeafWithRoot(pinnedRoot *workspaceConfinedUnixHandle, rootPath, relativePath string, maxCaptureBytes uint64) (workspaceTargetResult, uint64) {
	path, domainErr := openWorkspaceTargetPathWithRoot(pinnedRoot, rootPath, relativePath, true)
	if domainErr != nil {
		return workspaceTargetDomainResult(domainErr), 0
	}
	defer path.close()
	if path.isMissing() {
		return workspaceTargetStatus("missing"), 0
	}
	final := path.final()
	switch final.kind {
	case workspaceConfinedKindDirectory:
		result := workspaceTargetStatus("entry")
		result.Entry = workspaceTargetEntryOf(final)
		return result, 0
	case workspaceConfinedKindSymlink:
		if len(path.components) == 0 {
			return workspaceTargetError("not_link", "workspace path is not a symbolic link"), 0
		}
		parent := path.handles[len(path.handles)-2]
		target, err := readlinkatString(parent.fd, path.components[len(path.components)-1])
		if err != nil {
			return workspaceTargetError("io_failed", "link could not be read"), 0
		}
		if domainErr := revalidateWorkspaceTargetPath(path); domainErr != nil {
			return workspaceTargetDomainResult(domainErr), 0
		}
		result := workspaceTargetStatus("link")
		result.Entry = workspaceTargetEntryOf(final)
		result.Target = &target
		return result, 0
	case workspaceConfinedKindFile:
		captureInline := maxCaptureBytes > 0
		digest, content, _, readErr := readWorkspaceConfinedUnixFile(final, captureInline, maxCaptureBytes)
		if readErr != nil {
			return workspaceTargetDomainResult(readErr), 0
		}
		if domainErr := revalidateWorkspaceTargetPath(path); domainErr != nil {
			return workspaceTargetDomainResult(domainErr), 0
		}
		if content == nil {
			result := workspaceTargetStatus("entry")
			result.Entry = workspaceTargetEntryOf(final)
			result.Digest = digest
			return result, 0
		}
		encoded := base64.StdEncoding.EncodeToString(content)
		result := workspaceTargetStatus("leaf")
		result.Entry = workspaceTargetEntryOf(final)
		result.Digest = digest
		result.ContentBase64 = &encoded
		return result, uint64(len(content))
	default:
		result := workspaceTargetStatus("entry")
		result.Entry = workspaceTargetEntryOf(final)
		return result, 0
	}
}

func readlinkatString(parent int, name string) (string, error) {
	buffer := make([]byte, max(unix.PathMax, 4096))
	n, err := unix.Readlinkat(parent, name, buffer)
	if err != nil {
		return "", err
	}
	return string(buffer[:n]), nil
}

// resolveWorkspaceTargetRealpath follows links component by component through
// the handle chain; any step leaving the root is refused, never followed.
func resolveWorkspaceTargetRealpath(rootPath, relativePath string) (string, *workspaceConfinedDomainError, bool) {
	return resolveWorkspaceTargetRealpathWithRoot(nil, rootPath, relativePath)
}

func resolveWorkspaceTargetRealpathWithRoot(pinnedRoot *workspaceConfinedUnixHandle, rootPath, relativePath string) (string, *workspaceConfinedDomainError, bool) {
	if strings.IndexByte(relativePath, 0) >= 0 || filepath.IsAbs(relativePath) {
		return "", workspaceConfinedError("workspace_root_unsafe", "workspace path is not safe"), false
	}
	cleanRoot := filepath.Clean(rootPath)
	roots := make([]string, 0, 2)
	if pinnedRoot != nil {
		current, err := inspectWorkspaceConfinedUnixFD(pinnedRoot.fd)
		if err != nil || !workspaceTargetSameObject(current, *pinnedRoot) || current.kind != workspaceConfinedKindDirectory {
			return "", workspaceConfinedError("workspace_root_unsafe", "workspace root could not be opened safely"), false
		}
		physicalRoot, physicalErr := workspaceConfinedUnixPhysicalPath(pinnedRoot.fd)
		if physicalErr == nil && !strings.HasSuffix(physicalRoot, " (deleted)") {
			roots = append(roots, physicalRoot)
		}
		// Only accept cleanRoot as an alias for absolute symlinks if cleanRoot
		// still refers to the exact same pinned root inode (prevents root-rename hijack).
		if cleanRoot != physicalRoot {
			if reopened, openErr := openWorkspaceConfinedUnixRoot(cleanRoot); openErr == nil {
				sameRoot := workspaceTargetSameObject(reopened, *pinnedRoot)
				_ = unix.Close(reopened.fd)
				if sameRoot {
					roots = append(roots, cleanRoot)
				}
			}
		}
	} else {
		root, err := openWorkspaceConfinedUnixRoot(rootPath)
		if err != nil {
			return "", workspaceConfinedError("workspace_root_unsafe", "workspace root could not be opened safely"), false
		}
		physicalRoot, physicalErr := workspaceConfinedUnixPhysicalPath(root.fd)
		_ = unix.Close(root.fd)
		roots = append(roots, cleanRoot)
		if physicalErr == nil {
			roots = append(roots, physicalRoot)
		}
	}
	pending := []string{}
	if relativePath != "" {
		pending = strings.Split(relativePath, "/")
	}
	resolved := []string{}
	hops := 0
	for len(pending) > 0 {
		name := pending[0]
		pending = pending[1:]
		if name == "" || name == "." {
			continue
		}
		if name == ".." {
			if len(resolved) == 0 {
				return "", workspaceConfinedError("workspace_root_unsafe", "workspace path leaves the root"), false
			}
			resolved = resolved[:len(resolved)-1]
			continue
		}
		parent, domainErr := openWorkspaceTargetPathWithRoot(pinnedRoot, rootPath, strings.Join(resolved, "/"), false)
		if domainErr != nil {
			return "", domainErr, false
		}
		if parent.isMissing() || parent.final().kind != workspaceConfinedKindDirectory {
			parent.close()
			return "", workspaceConfinedError("workspace_root_unsafe", "workspace path traverses a non-directory"), false
		}
		var stat unix.Stat_t
		statErr := unix.Fstatat(parent.final().fd, name, &stat, unix.AT_SYMLINK_NOFOLLOW)
		if errors.Is(statErr, unix.ENOENT) {
			parent.close()
			return "", nil, true
		}
		if statErr != nil {
			parent.close()
			return "", workspaceConfinedError("io_failed", "workspace entry could not be inspected"), false
		}
		if uint32(stat.Mode)&unix.S_IFMT != unix.S_IFLNK {
			parent.close()
			resolved = append(resolved, name)
			continue
		}
		target, linkErr := readlinkatString(parent.final().fd, name)
		parent.close()
		if linkErr != nil {
			return "", workspaceConfinedError("io_failed", "link could not be read"), false
		}
		if hops++; hops > workspaceTargetMaxLinkHops {
			return "", workspaceConfinedError("symlink_loop", "too many symbolic links"), false
		}
		if filepath.IsAbs(target) {
			inside := ""
			matched := false
			for _, candidate := range roots {
				rel, err := filepath.Rel(candidate, filepath.Clean(target))
				if err == nil && rel != ".." && !strings.HasPrefix(rel, "../") {
					inside, matched = rel, true
					break
				}
			}
			if !matched {
				return "", workspaceConfinedError("workspace_root_unsafe", "link leaves the workspace root"), false
			}
			resolved = []string{}
			if inside != "." {
				pending = append(strings.Split(inside, "/"), pending...)
			}
			continue
		}
		pending = append(strings.Split(target, "/"), pending...)
	}
	return strings.Join(resolved, "/"), nil, false
}

func hasherReadUnixFD(fd int, hasher io.Writer) (int64, error) {
	buffer := make([]byte, 64*1024)
	var total int64
	for {
		count, err := unix.Read(fd, buffer)
		if count > 0 {
			_, _ = hasher.Write(buffer[:count])
			total += int64(count)
		}
		if err != nil {
			if errors.Is(err, unix.EINTR) {
				continue
			}
			return 0, err
		}
		if count == 0 {
			return total, nil
		}
	}
}

func workspaceTargetSha256(handle workspaceConfinedUnixHandle) (string, error) {
	if _, err := unix.Seek(handle.fd, 0, 0); err != nil {
		return "", err
	}
	hasher := sha256.New()
	if _, err := hasherReadUnixFD(handle.fd, hasher); err != nil {
		return "", err
	}
	return hex.EncodeToString(hasher.Sum(nil)), nil
}

func runWorkspaceTargetWrite(request workspaceTargetWriteRequest, content []byte) workspaceTargetResult {
	return runWorkspaceTargetWriteWithRoot(nil, request, content)
}

func runWorkspaceTargetWriteWithRoot(pinnedRoot *workspaceConfinedUnixHandle, request workspaceTargetWriteRequest, content []byte) workspaceTargetResult {
	switch request.op {
	case "put":
		return putWorkspaceTargetFileWithRoot(pinnedRoot, request, content)
	case "mkdir":
		return mkdirWorkspaceTargetWithRoot(pinnedRoot, request)
	case "rename":
		return renameWorkspaceTargetWithRoot(pinnedRoot, request)
	case "copy-exclusive":
		return copyExclusiveWorkspaceTargetFileWithRoot(pinnedRoot, request)
	case "set-times":
		return setWorkspaceTargetFileTimesWithRoot(pinnedRoot, request)
	case "rmdir":
		parent, name, domainErr := splitWorkspaceTargetParentWithRoot(pinnedRoot, request.rootPath, request.relativePath)
		if domainErr != nil {
			return workspaceTargetDomainResult(domainErr)
		}
		defer parent.close()
		if err := unix.Unlinkat(parent.final().fd, name, unix.AT_REMOVEDIR); err != nil {
			if errors.Is(err, unix.ENOENT) {
				return workspaceTargetStatus("missing")
			}
			if errors.Is(err, unix.ENOTEMPTY) || errors.Is(err, unix.EEXIST) {
				return workspaceTargetError("not_empty", "folder is not empty")
			}
			return workspaceTargetError("io_failed", "folder could not be removed")
		}
		return workspaceTargetStatus("done")
	}
	return workspaceTargetError("workspace_root_unsafe", "unknown op")
}

// splitWorkspaceTargetParent opens the parent directory chain of a root-relative path.
func splitWorkspaceTargetParent(rootPath, relativePath string) (*workspaceConfinedUnixPath, string, *workspaceConfinedDomainError) {
	return splitWorkspaceTargetParentWithRoot(nil, rootPath, relativePath)
}

func splitWorkspaceTargetParentWithRoot(pinnedRoot *workspaceConfinedUnixHandle, rootPath, relativePath string) (*workspaceConfinedUnixPath, string, *workspaceConfinedDomainError) {
	if relativePath == "" {
		return nil, "", workspaceConfinedError("workspace_root_unsafe", "the root itself cannot be replaced")
	}
	if _, domainErr := validateWorkspaceConfinedUnixRelativePath(relativePath); domainErr != nil {
		return nil, "", domainErr
	}
	dir, name := "", relativePath
	if index := strings.LastIndexByte(relativePath, '/'); index >= 0 {
		dir, name = relativePath[:index], relativePath[index+1:]
	}
	parent, domainErr := openWorkspaceTargetPathWithRoot(pinnedRoot, rootPath, dir, false)
	if domainErr != nil {
		return nil, "", domainErr
	}
	if parent.isMissing() || parent.final().kind != workspaceConfinedKindDirectory {
		parent.close()
		return nil, "", workspaceConfinedError("not_directory", "parent is not a directory")
	}
	return parent, name, nil
}

func accessWorkspaceTargetExecutable(rootPath, relativePath string) workspaceTargetResult {
	return accessWorkspaceTargetExecutableWithRoot(nil, rootPath, relativePath)
}

func accessWorkspaceTargetExecutableWithRoot(pinnedRoot *workspaceConfinedUnixHandle, rootPath, relativePath string) workspaceTargetResult {
	path, domainErr := openWorkspaceTargetPathWithRoot(pinnedRoot, rootPath, relativePath, true)
	if domainErr != nil {
		return workspaceTargetDomainResult(domainErr)
	}
	defer path.close()
	if path.isMissing() {
		return workspaceTargetStatus("missing")
	}
	return workspaceTargetAccessExecutable(path)
}

func setWorkspaceTargetFileTimesWithRoot(pinnedRoot *workspaceConfinedUnixHandle, request workspaceTargetWriteRequest) workspaceTargetResult {
	parent, name, domainErr := splitWorkspaceTargetParentWithRoot(pinnedRoot, request.rootPath, request.relativePath)
	if domainErr != nil {
		return workspaceTargetDomainResult(domainErr)
	}
	defer parent.close()
	atime, atimeErr := unix.TimeToTimespec(time.UnixMilli(request.atimeMs))
	mtime, mtimeErr := unix.TimeToTimespec(time.UnixMilli(request.mtimeMs))
	if atimeErr != nil || mtimeErr != nil {
		return workspaceTargetError("io_failed", "file timestamps are out of range")
	}
	if err := unix.UtimesNanoAt(parent.final().fd, name, []unix.Timespec{atime, mtime}, unix.AT_SYMLINK_NOFOLLOW); err != nil {
		return workspaceTargetError("io_failed", "file timestamps could not be set")
	}
	return workspaceTargetStatus("done")
}

func copyWorkspaceTargetFile(file *os.File, source workspaceConfinedUnixHandle) error {
	fd, err := unix.Dup(source.fd)
	if err != nil {
		return err
	}
	unix.CloseOnExec(fd)
	input := os.NewFile(uintptr(fd), "confined source")
	defer input.Close()
	if _, err := input.Seek(0, 0); err != nil {
		return err
	}
	_, err = io.Copy(file, input)
	return err
}

func createExclusiveWorkspaceTargetFile(parent *workspaceConfinedUnixPath, name string, mode uint32) (*os.File, workspaceTargetResult) {
	fd, err := unix.Openat(parent.final().fd, name, unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW|unix.O_CLOEXEC, mode)
	if errors.Is(err, unix.EEXIST) {
		return nil, workspaceTargetStatus("exists")
	}
	if err != nil {
		return nil, workspaceTargetError("io_failed", "exclusive file could not be opened")
	}
	return os.NewFile(uintptr(fd), name), workspaceTargetStatus("opened")
}

func copyExclusiveWorkspaceTargetFileWithRoot(pinnedRoot *workspaceConfinedUnixHandle, request workspaceTargetWriteRequest) workspaceTargetResult {
	source, domainErr := openWorkspaceTargetPathWithRoot(pinnedRoot, request.rootPath, request.relativePath, true)
	if domainErr != nil {
		return workspaceTargetDomainResult(domainErr)
	}
	defer source.close()
	if source.isMissing() {
		return workspaceTargetStatus("missing")
	}
	entry := source.final()
	if entry.kind != workspaceConfinedKindFile {
		return workspaceTargetError("workspace_file_unsupported", "source is not a regular file")
	}
	parent, name, domainErr := splitWorkspaceTargetParentWithRoot(pinnedRoot, request.rootPath, request.toRelativePath)
	if domainErr != nil {
		return workspaceTargetDomainResult(domainErr)
	}
	defer parent.close()
	fileMode := uint32(entry.stat.Mode) & 0o777
	file, result := createExclusiveWorkspaceTargetFile(parent, name, fileMode)
	if file == nil {
		return result
	}
	copyErr := copyWorkspaceTargetFile(file, entry)
	modeErr := file.Chmod(os.FileMode(fileMode))
	closeErr := file.Close()
	if copyErr != nil || modeErr != nil || closeErr != nil {
		_ = unix.Unlinkat(parent.final().fd, name, 0)
		return workspaceTargetError("io_failed", "exclusive file copy failed")
	}
	result = workspaceTargetStatus("done")
	result.Entry = workspaceTargetEntryOf(entry)
	return result
}

// Readiness is acknowledged only after exclusive creation. The client may
// then close the file, or ask us to copy and fsync bytes into that same inode.
func openExclusiveWorkspaceTargetFile(request workspaceTargetWriteRequest, reader *bufio.Reader, output io.Writer) error {
	respond := func(result workspaceTargetResult) error { return writeWorkspaceConfinedRecord(output, result) }
	parent, name, domainErr := splitWorkspaceTargetParent(request.rootPath, request.relativePath)
	if domainErr != nil {
		return respond(workspaceTargetDomainResult(domainErr))
	}
	defer parent.close()
	file, result := createExclusiveWorkspaceTargetFile(parent, name, 0o666)
	if file == nil {
		return respond(result)
	}
	defer file.Close()
	var stat unix.Stat_t
	if err := unix.Fstat(int(file.Fd()), &stat); err != nil {
		_ = unix.Unlinkat(parent.final().fd, name, 0)
		return respond(workspaceTargetError("io_failed", "exclusive file mode could not be read"))
	}
	result.Entry = &workspaceTargetEntry{Mode: uint32(stat.Mode)}
	if err := respond(result); err != nil {
		_ = unix.Unlinkat(parent.final().fd, name, 0)
		return err
	}
	line, err := readWorkspaceConfinedLine(reader)
	if errors.Is(err, io.EOF) {
		return respond(workspaceTargetStatus("done"))
	}
	if err != nil {
		return respond(workspaceTargetError("io_failed", "exclusive file input could not be read"))
	}
	fields, err := decodeClosedWorkspaceConfinedObject(line, map[string]bool{"relativePath": true, "mode": true})
	if err != nil {
		return respond(workspaceTargetError("workspace_root_unsafe", "invalid exclusive file input"))
	}
	from, err := decodeRequiredString(fields, "relativePath")
	if err != nil {
		return respond(workspaceTargetError("workspace_root_unsafe", "invalid exclusive file source path"))
	}
	source, domainErr := openWorkspaceTargetPath(request.rootPath, from, false)
	if domainErr != nil {
		return respond(workspaceTargetDomainResult(domainErr))
	}
	defer source.close()
	if source.isMissing() || source.final().kind != workspaceConfinedKindFile {
		return respond(workspaceTargetError("workspace_file_unsupported", "source is not a regular file"))
	}
	if raw, ok := fields["mode"]; ok {
		var mode uint32
		if json.Unmarshal(raw, &mode) != nil || mode > 0o777 {
			return respond(workspaceTargetError("workspace_root_unsafe", "invalid exclusive file mode"))
		}
		if err := file.Chmod(os.FileMode(mode)); err != nil {
			return respond(workspaceTargetError("io_failed", "exclusive file mode could not be set"))
		}
	}
	if err := copyWorkspaceTargetFile(file, source.final()); err != nil {
		return respond(workspaceTargetError("io_failed", "exclusive file could not be written"))
	}
	if err := file.Sync(); err != nil {
		return respond(workspaceTargetError("io_failed", "exclusive file could not be flushed"))
	}
	return respond(workspaceTargetStatus("done"))
}

func putWorkspaceTargetFileWithRoot(pinnedRoot *workspaceConfinedUnixHandle, request workspaceTargetWriteRequest, content []byte) workspaceTargetResult {
	parent, name, domainErr := splitWorkspaceTargetParentWithRoot(pinnedRoot, request.rootPath, request.relativePath)
	if domainErr != nil {
		return workspaceTargetDomainResult(domainErr)
	}
	defer parent.close()
	directory := parent.final().fd
	current, err := openWorkspaceConfinedUnixAt(directory, name)
	exists := err == nil
	if err != nil && !errors.Is(err, unix.ENOENT) {
		return workspaceTargetError("workspace_file_unsupported", "existing entry is not a regular file or directory")
	}
	if exists {
		defer unix.Close(current.fd)
		if current.kind != workspaceConfinedKindFile {
			return workspaceTargetError("workspace_file_unsupported", "existing entry is not a regular file")
		}
	}
	switch {
	case request.expect == "absent" && exists:
		return workspaceTargetStatus("exists")
	case request.expect != "absent" && request.expect != "any":
		if !exists {
			return workspaceTargetStatus("missing")
		}
		actual, err := workspaceTargetSha256(current)
		if err != nil {
			return workspaceTargetError("io_failed", "existing file could not be hashed")
		}
		if actual != request.expect {
			result := workspaceTargetStatus("changed")
			result.Sha256 = actual
			return result
		}
	}
	suffix := make([]byte, 8)
	if _, err := rand.Read(suffix); err != nil {
		return workspaceTargetError("io_failed", "staging name unavailable")
	}
	staged := ".happier-write-" + hex.EncodeToString(suffix)
	fd, err := unix.Openat(directory, staged, unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW|unix.O_CLOEXEC, request.mode)
	if err != nil {
		return workspaceTargetError("io_failed", "staged file could not be created")
	}
	written := 0
	for written < len(content) {
		n, err := unix.Write(fd, content[written:])
		if err != nil {
			if errors.Is(err, unix.EINTR) {
				continue
			}
			_ = unix.Close(fd)
			_ = unix.Unlinkat(directory, staged, 0)
			return workspaceTargetError("io_failed", "staged file could not be written")
		}
		written += n
	}
	if err := unix.Fsync(fd); err != nil || unix.Close(fd) != nil {
		_ = unix.Unlinkat(directory, staged, 0)
		return workspaceTargetError("io_failed", "staged file could not be flushed")
	}
	// The parent chain must still be the one checked; the publish never follows a swapped ancestor.
	if domainErr := revalidateWorkspaceTargetPath(parent); domainErr != nil {
		_ = unix.Unlinkat(directory, staged, 0)
		return workspaceTargetDomainResult(domainErr)
	}
	if exists && revalidateWorkspaceConfinedUnixName(directory, name, current) != nil {
		_ = unix.Unlinkat(directory, staged, 0)
		return workspaceTargetError("conflict_changed", "file changed before publish")
	}
	if err := workspaceTargetRenamePublish(directory, staged, name, exists); err != nil {
		_ = unix.Unlinkat(directory, staged, 0)
		if errors.Is(err, unix.EEXIST) {
			return workspaceTargetStatus("exists")
		}
		return workspaceTargetError("io_failed", "file could not be published")
	}
	sum := sha256.Sum256(content)
	result := workspaceTargetStatus("written")
	result.Sha256 = hex.EncodeToString(sum[:])
	return result
}

func mkdirWorkspaceTargetWithRoot(pinnedRoot *workspaceConfinedUnixHandle, request workspaceTargetWriteRequest) workspaceTargetResult {
	parts, domainErr := validateWorkspaceConfinedUnixRelativePath(request.relativePath)
	if domainErr != nil {
		return workspaceTargetDomainResult(domainErr)
	}
	start := len(parts) - 1
	if request.recursive {
		start = 0
	}
	for index := start; index < len(parts); index++ {
		parent, domainErr := openWorkspaceTargetPathWithRoot(pinnedRoot, request.rootPath, strings.Join(parts[:index], "/"), false)
		if domainErr != nil {
			return workspaceTargetDomainResult(domainErr)
		}
		if parent.isMissing() || parent.final().kind != workspaceConfinedKindDirectory {
			parent.close()
			return workspaceTargetError("not_directory", "parent is not a directory")
		}
		err := unix.Mkdirat(parent.final().fd, parts[index], request.mode|0o100)
		parent.close()
		if err != nil && !(errors.Is(err, unix.EEXIST) && (request.recursive || index < len(parts)-1)) {
			if errors.Is(err, unix.EEXIST) {
				return workspaceTargetStatus("exists")
			}
			return workspaceTargetError("io_failed", "folder could not be created")
		}
	}
	return workspaceTargetStatus("done")
}

func renameWorkspaceTargetWithRoot(pinnedRoot *workspaceConfinedUnixHandle, request workspaceTargetWriteRequest) workspaceTargetResult {
	from, fromName, domainErr := splitWorkspaceTargetParentWithRoot(pinnedRoot, request.rootPath, request.relativePath)
	if domainErr != nil {
		return workspaceTargetDomainResult(domainErr)
	}
	defer from.close()
	to, toName, domainErr := splitWorkspaceTargetParentWithRoot(pinnedRoot, request.rootPath, request.toRelativePath)
	if domainErr != nil {
		return workspaceTargetDomainResult(domainErr)
	}
	defer to.close()
	if err := unix.Renameat(from.final().fd, fromName, to.final().fd, toName); err != nil {
		if errors.Is(err, unix.ENOENT) {
			return workspaceTargetStatus("missing")
		}
		return workspaceTargetError("io_failed", "entry could not be renamed")
	}
	return workspaceTargetStatus("done")
}
