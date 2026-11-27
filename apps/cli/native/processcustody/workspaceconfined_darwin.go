//go:build darwin

package main

import (
	"bytes"
	"crypto/rand"
	"crypto/sha1"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"unsafe"

	"golang.org/x/sys/unix"
)

type workspaceConfinedDarwinIdentity struct {
	device int32
	inode  uint64
}

type workspaceConfinedDarwinHandle struct {
	fd       int
	identity workspaceConfinedDarwinIdentity
	kind     workspaceConfinedKind
	stat     unix.Stat_t
}

type workspaceConfinedDarwinHeldPath struct {
	rootPath               string
	components             []string
	handles                []workspaceConfinedDarwinHandle
	missingIndex           int
	missingAncestorAllowed bool
	// When non-nil, handles[0] borrows the worker's pinned root dirfd: close()
	// leaves it open and revalidate() re-walks strictly from this dirfd without
	// reopening rootPath by name.
	pinnedRoot *workspaceConfinedDarwinHandle
}

type workspaceConfinedDarwinReadOperation struct {
	path    *workspaceConfinedDarwinHeldPath
	request workspaceConfinedReadRequest
}

type workspaceConfinedDarwinDeleteOperation struct {
	path              *workspaceConfinedDarwinHeldPath
	request           workspaceConfinedDeleteRequest
	preconditionError *workspaceConfinedDomainError
}

func prepareWorkspaceConfinedRead(request workspaceConfinedReadRequest) (workspaceConfinedPreparedOperation, *workspaceConfinedDomainError) {
	return prepareWorkspaceConfinedReadWithRoot(nil, request)
}

func prepareWorkspaceConfinedReadWithRoot(pinnedRoot *workspaceConfinedDarwinHandle, request workspaceConfinedReadRequest) (workspaceConfinedPreparedOperation, *workspaceConfinedDomainError) {
	held, domainErr := openWorkspaceConfinedDarwinHeldPathWithRoot(pinnedRoot, request.rootPath, request.relativePath, true)
	if domainErr != nil {
		return nil, domainErr
	}
	operation := &workspaceConfinedDarwinReadOperation{path: held, request: request}
	if held.missingIndex < 0 && held.final().kind == workspaceConfinedKindFile && request.expectedDigest != "" {
		if _, _, _, domainErr := readWorkspaceConfinedDarwinFile(held.final(), false, 0); domainErr != nil {
			held.close()
			return nil, domainErr
		}
	}
	return operation, nil
}

func prepareWorkspaceConfinedDelete(request workspaceConfinedDeleteRequest) (workspaceConfinedPreparedOperation, *workspaceConfinedDomainError) {
	return prepareWorkspaceConfinedDeleteWithRoot(nil, request)
}

func prepareWorkspaceConfinedDeleteWithRoot(pinnedRoot *workspaceConfinedDarwinHandle, request workspaceConfinedDeleteRequest) (workspaceConfinedPreparedOperation, *workspaceConfinedDomainError) {
	held, domainErr := openWorkspaceConfinedDarwinHeldPathWithRoot(pinnedRoot, request.rootPath, request.relativePath, true)
	if domainErr != nil {
		return nil, domainErr
	}
	operation := &workspaceConfinedDarwinDeleteOperation{path: held, request: request}
	actualKind := workspaceConfinedKindMissing
	if held.missingIndex < 0 {
		actualKind = held.final().kind
	}
	if actualKind != request.expectedKind {
		operation.preconditionError = workspaceConfinedError("conflict_changed", "conflict loser type changed")
		return operation, nil
	}
	if request.expectedKind == workspaceConfinedKindFile {
		digest, _, _, digestErr := readWorkspaceConfinedDarwinFile(held.final(), false, 0)
		if digestErr != nil {
			held.close()
			return nil, digestErr
		}
		if digest != request.expectedDigest {
			operation.preconditionError = workspaceConfinedError("conflict_changed", "conflict loser digest changed")
		}
	}
	return operation, nil
}

func (operation *workspaceConfinedDarwinReadOperation) close() {
	operation.path.close()
}

func (operation *workspaceConfinedDarwinReadOperation) commit() workspaceConfinedResult {
	if domainErr := operation.path.revalidate(); domainErr != nil {
		return domainErr.result()
	}
	if operation.path.missingIndex >= 0 {
		return workspaceConfinedSuccess("missing")
	}
	final := operation.path.final()
	if final.kind != workspaceConfinedKindFile {
		return workspaceConfinedError("workspace_file_unsupported", "workspace preview supports only regular files").result()
	}
	current, err := inspectWorkspaceConfinedDarwinFD(final.fd)
	if err != nil || !sameWorkspaceConfinedDarwinObject(current, final) || current.kind != workspaceConfinedKindFile {
		return workspaceConfinedError("conflict_changed", "workspace file changed before reading").result()
	}
	size, domainErr := workspaceConfinedDarwinFileSize(current.stat)
	if domainErr != nil {
		return domainErr.result()
	}
	if size > workspaceConfinedMaxSafeJSONInteger {
		return workspaceConfinedError("workspace_file_unsupported", "workspace file size is not representable").result()
	}
	if size > uint64(operation.request.maxBytes) && operation.request.expectedDigest == "" {
		return workspaceConfinedResult{
			V: 1, T: "workspace-confined-result", Status: "too_large", Size: workspaceConfinedUint64(size),
		}
	}
	digest, content, currentSize, readErr := readWorkspaceConfinedDarwinFile(final, size <= uint64(operation.request.maxBytes), uint64(operation.request.maxBytes))
	if readErr != nil {
		return readErr.result()
	}
	if operation.request.expectedDigest != "" && digest != operation.request.expectedDigest {
		return workspaceConfinedResult{
			V: 1, T: "workspace-confined-result", Status: "changed", ActualDigest: digest,
		}
	}
	if currentSize > uint64(operation.request.maxBytes) {
		return workspaceConfinedResult{
			V: 1, T: "workspace-confined-result", Status: "too_large", Size: workspaceConfinedUint64(currentSize), Digest: digest,
		}
	}
	return workspaceConfinedResult{
		V:             1,
		T:             "workspace-confined-result",
		Status:        "content",
		Size:          workspaceConfinedUint64(currentSize),
		Digest:        digest,
		ContentBase64: workspaceConfinedString(base64.StdEncoding.EncodeToString(content)),
	}
}

func (operation *workspaceConfinedDarwinDeleteOperation) close() {
	operation.path.close()
}

func (operation *workspaceConfinedDarwinDeleteOperation) commit() workspaceConfinedResult {
	if domainErr := operation.path.revalidate(); domainErr != nil {
		return domainErr.result()
	}
	if operation.preconditionError != nil {
		return operation.preconditionError.result()
	}
	if operation.request.expectedKind == workspaceConfinedKindMissing {
		return workspaceConfinedSuccess("deleted")
	}
	final := operation.path.final()
	current, err := inspectWorkspaceConfinedDarwinFD(final.fd)
	if err != nil || !sameWorkspaceConfinedDarwinObject(current, final) || current.kind != operation.request.expectedKind {
		return workspaceConfinedError("conflict_changed", "conflict loser type changed").result()
	}
	if operation.request.expectedKind == workspaceConfinedKindFile {
		digest, _, _, digestErr := readWorkspaceConfinedDarwinFile(final, false, 0)
		if digestErr != nil {
			return digestErr.result()
		}
		if digest != operation.request.expectedDigest {
			return workspaceConfinedError("conflict_changed", "conflict loser digest changed").result()
		}
	}
	parent := operation.path.handles[len(operation.path.handles)-2]
	finalName := operation.path.components[len(operation.path.components)-1]
	if err := revalidateWorkspaceConfinedDarwinName(parent.fd, finalName, final); err != nil {
		return workspaceConfinedError("conflict_changed", "conflict loser changed before quarantine").result()
	}
	parentPath, err := workspaceConfinedDarwinPhysicalPath(parent.fd)
	if err != nil {
		return workspaceConfinedError("workspace_root_unsafe", "could not resolve the conflict recovery directory").result()
	}
	quarantineName, err := quarantineWorkspaceConfinedDarwinEntry(parent.fd, finalName, final)
	if err != nil {
		return workspaceConfinedError("conflict_changed", "conflict loser changed before quarantine").result()
	}
	recoveryPath, pathErr := workspaceConfinedDarwinPhysicalPath(final.fd)
	if pathErr != nil {
		recoveryPath = filepath.Join(parentPath, quarantineName)
	}
	quarantined, err := openWorkspaceConfinedDarwinComponent(parent.fd, quarantineName)
	if err != nil || !sameWorkspaceConfinedDarwinObject(quarantined, final) {
		if err == nil {
			_ = unix.Close(quarantined.fd)
		}
		return workspaceConfinedRecoveryError(
			"conflict_changed",
			"conflict loser could not be safely reopened; recovery material remains quarantined",
			recoveryPath,
		).result()
	}
	deleteErr := deleteWorkspaceConfinedDarwinTree(parent.fd, quarantineName, quarantined)
	closeErr := unix.Close(quarantined.fd)
	if deleteErr != nil || closeErr != nil {
		return workspaceConfinedRecoveryError(
			"conflict_changed",
			"conflict loser could not be safely finalized; recovery material remains quarantined",
			recoveryPath,
		).result()
	}
	return workspaceConfinedSuccess("deleted")
}

func validateWorkspaceConfinedDarwinRelativePath(relativePath string) ([]string, *workspaceConfinedDomainError) {
	if relativePath == "" || strings.IndexByte(relativePath, 0) >= 0 || filepath.IsAbs(relativePath) {
		return nil, workspaceConfinedError("workspace_root_unsafe", "workspace path is not a safe relative path")
	}
	components := strings.Split(relativePath, "/")
	for _, component := range components {
		if component == "" || component == "." || component == ".." || strings.IndexByte(component, 0) >= 0 {
			return nil, workspaceConfinedError("workspace_root_unsafe", "workspace path contains an unsafe component")
		}
	}
	return components, nil
}

func openWorkspaceConfinedDarwinRoot(rootPath string) (string, workspaceConfinedDarwinHandle, error) {
	if rootPath == "" || strings.IndexByte(rootPath, 0) >= 0 || !filepath.IsAbs(rootPath) {
		return "", workspaceConfinedDarwinHandle{}, fmt.Errorf("workspace root must be an absolute path")
	}
	cleaned := filepath.Clean(rootPath)
	fd, err := unix.Open(cleaned, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return "", workspaceConfinedDarwinHandle{}, err
	}
	handle, err := inspectWorkspaceConfinedDarwinFD(fd)
	if err != nil || handle.kind != workspaceConfinedKindDirectory {
		_ = unix.Close(fd)
		if err != nil {
			return "", workspaceConfinedDarwinHandle{}, err
		}
		return "", workspaceConfinedDarwinHandle{}, fmt.Errorf("workspace root is not a real directory")
	}
	return cleaned, handle, nil
}

func openWorkspaceConfinedDarwinHeldPath(rootPath, relativePath string) (*workspaceConfinedDarwinHeldPath, *workspaceConfinedDomainError) {
	return openWorkspaceConfinedDarwinHeldPathWithRoot(nil, rootPath, relativePath, true)
}

func openWorkspaceConfinedDarwinHeldPathWithRoot(pinnedRoot *workspaceConfinedDarwinHandle, rootPath, relativePath string, missingAncestorAllowed bool) (*workspaceConfinedDarwinHeldPath, *workspaceConfinedDomainError) {
	components, domainErr := validateWorkspaceConfinedDarwinRelativePath(relativePath)
	if domainErr != nil {
		return nil, domainErr
	}
	var cleanedRoot string
	var root workspaceConfinedDarwinHandle
	if pinnedRoot != nil {
		current, err := inspectWorkspaceConfinedDarwinFD(pinnedRoot.fd)
		if err != nil || !sameWorkspaceConfinedDarwinObject(current, *pinnedRoot) || current.kind != workspaceConfinedKindDirectory {
			return nil, workspaceConfinedError("workspace_root_unsafe", "workspace root could not be opened safely")
		}
		cleanedRoot = filepath.Clean(rootPath)
		root = current
	} else {
		var err error
		cleanedRoot, root, err = openWorkspaceConfinedDarwinRoot(rootPath)
		if err != nil {
			return nil, workspaceConfinedError("workspace_root_unsafe", "workspace root could not be opened safely")
		}
	}
	held := &workspaceConfinedDarwinHeldPath{
		rootPath:               cleanedRoot,
		components:             components,
		handles:                []workspaceConfinedDarwinHandle{root},
		missingIndex:           -1,
		missingAncestorAllowed: missingAncestorAllowed,
		pinnedRoot:             pinnedRoot,
	}
	parent := root.fd
	for index, component := range components {
		child, err := openWorkspaceConfinedDarwinComponent(parent, component)
		if err != nil {
			if errors.Is(err, unix.ENOENT) && (index == len(components)-1 || missingAncestorAllowed) {
				held.missingIndex = index
				return held, nil
			}
			held.close()
			return nil, workspaceConfinedError("workspace_root_unsafe", "workspace path could not be opened safely")
		}
		if index < len(components)-1 && child.kind != workspaceConfinedKindDirectory {
			_ = unix.Close(child.fd)
			held.close()
			return nil, workspaceConfinedError("workspace_root_unsafe", "workspace path traverses a non-directory or symlink")
		}
		held.handles = append(held.handles, child)
		parent = child.fd
	}
	return held, nil
}

func openWorkspaceConfinedDarwinComponent(parent int, component string) (workspaceConfinedDarwinHandle, error) {
	var observed unix.Stat_t
	if err := unix.Fstatat(parent, component, &observed, unix.AT_SYMLINK_NOFOLLOW); err != nil {
		return workspaceConfinedDarwinHandle{}, err
	}
	kind, err := workspaceConfinedDarwinKind(observed.Mode)
	if err != nil {
		return workspaceConfinedDarwinHandle{}, err
	}
	flags := unix.O_RDONLY | unix.O_CLOEXEC
	switch kind {
	case workspaceConfinedKindDirectory:
		flags |= unix.O_DIRECTORY | unix.O_NOFOLLOW
	case workspaceConfinedKindFile:
		flags |= unix.O_NOFOLLOW | unix.O_NONBLOCK
	case workspaceConfinedKindSymlink:
		flags |= unix.O_SYMLINK
	}
	fd, err := unix.Openat(parent, component, flags, 0)
	if err != nil {
		return workspaceConfinedDarwinHandle{}, err
	}
	opened, err := inspectWorkspaceConfinedDarwinFD(fd)
	if err != nil {
		_ = unix.Close(fd)
		return workspaceConfinedDarwinHandle{}, err
	}
	expected := workspaceConfinedDarwinHandle{identity: workspaceConfinedDarwinIdentity{device: observed.Dev, inode: observed.Ino}, kind: kind}
	if !sameWorkspaceConfinedDarwinObject(opened, expected) {
		_ = unix.Close(fd)
		return workspaceConfinedDarwinHandle{}, fmt.Errorf("workspace path changed while acquiring its handle")
	}
	return opened, nil
}

func inspectWorkspaceConfinedDarwinFD(fd int) (workspaceConfinedDarwinHandle, error) {
	var stat unix.Stat_t
	if err := unix.Fstat(fd, &stat); err != nil {
		return workspaceConfinedDarwinHandle{}, err
	}
	kind, err := workspaceConfinedDarwinKind(stat.Mode)
	if err != nil {
		return workspaceConfinedDarwinHandle{}, err
	}
	return workspaceConfinedDarwinHandle{
		fd: fd, identity: workspaceConfinedDarwinIdentity{device: stat.Dev, inode: stat.Ino}, kind: kind, stat: stat,
	}, nil
}

func workspaceConfinedDarwinKind(mode uint16) (workspaceConfinedKind, error) {
	switch uint32(mode) & unix.S_IFMT {
	case unix.S_IFREG:
		return workspaceConfinedKindFile, nil
	case unix.S_IFDIR:
		return workspaceConfinedKindDirectory, nil
	case unix.S_IFLNK:
		return workspaceConfinedKindSymlink, nil
	default:
		return "", fmt.Errorf("workspace path has an unsupported filesystem type")
	}
}

func sameWorkspaceConfinedDarwinObject(first, second workspaceConfinedDarwinHandle) bool {
	return first.identity == second.identity && first.kind == second.kind
}

func (path *workspaceConfinedDarwinHeldPath) final() workspaceConfinedDarwinHandle {
	return path.handles[len(path.handles)-1]
}

func (path *workspaceConfinedDarwinHeldPath) close() {
	start := 0
	if path.pinnedRoot != nil {
		start = 1
	}
	for index := len(path.handles) - 1; index >= start; index-- {
		if path.handles[index].fd >= 0 {
			_ = unix.Close(path.handles[index].fd)
		}
	}
	path.handles = nil
}

func (path *workspaceConfinedDarwinHeldPath) revalidate() *workspaceConfinedDomainError {
	var currentRoot workspaceConfinedDarwinHandle
	var err error
	opened := make([]workspaceConfinedDarwinHandle, 0, len(path.handles))
	if path.pinnedRoot != nil {
		currentRoot, err = inspectWorkspaceConfinedDarwinFD(path.pinnedRoot.fd)
		if err != nil || !sameWorkspaceConfinedDarwinObject(currentRoot, *path.pinnedRoot) || currentRoot.kind != workspaceConfinedKindDirectory {
			return workspaceConfinedError("conflict_changed", "workspace root changed before commit")
		}
	} else {
		_, currentRoot, err = openWorkspaceConfinedDarwinRoot(path.rootPath)
		if err != nil {
			return workspaceConfinedError("workspace_root_unsafe", "workspace root changed before commit")
		}
		opened = append(opened, currentRoot)
	}
	defer func() {
		for index := len(opened) - 1; index >= 0; index-- {
			_ = unix.Close(opened[index].fd)
		}
	}()
	if !sameWorkspaceConfinedDarwinObject(currentRoot, path.handles[0]) {
		if path.pinnedRoot != nil {
			return workspaceConfinedError("conflict_changed", "workspace root changed before commit")
		}
		return workspaceConfinedError("workspace_root_unsafe", "workspace root changed before commit")
	}
	parent := currentRoot.fd
	for index, component := range path.components {
		child, err := openWorkspaceConfinedDarwinComponent(parent, component)
		if index == path.missingIndex {
			if errors.Is(err, unix.ENOENT) {
				return nil
			}
			if err == nil {
				_ = unix.Close(child.fd)
			}
			return workspaceConfinedError("conflict_changed", "workspace path changed before commit")
		}
		if err != nil {
			return workspaceConfinedError("conflict_changed", "workspace path changed before commit")
		}
		opened = append(opened, child)
		expected := path.handles[index+1]
		if !sameWorkspaceConfinedDarwinObject(child, expected) {
			return workspaceConfinedError("conflict_changed", "workspace path changed before commit")
		}
		if index < len(path.components)-1 && child.kind != workspaceConfinedKindDirectory {
			return workspaceConfinedError("conflict_changed", "workspace path changed before commit")
		}
		parent = child.fd
	}
	return nil
}

func workspaceConfinedDarwinFileSize(stat unix.Stat_t) (uint64, *workspaceConfinedDomainError) {
	if stat.Size < 0 {
		return 0, workspaceConfinedError("workspace_file_unsupported", "workspace file size is invalid")
	}
	return uint64(stat.Size), nil
}

func sameWorkspaceConfinedDarwinFileObservation(first, second unix.Stat_t) bool {
	return first.Dev == second.Dev && first.Ino == second.Ino && first.Mode == second.Mode &&
		first.Size == second.Size && first.Mtim == second.Mtim && first.Ctim == second.Ctim &&
		first.Flags == second.Flags && first.Gen == second.Gen
}

func readWorkspaceConfinedDarwinFile(file workspaceConfinedDarwinHandle, capture bool, maxCapture uint64) (string, []byte, uint64, *workspaceConfinedDomainError) {
	if file.kind != workspaceConfinedKindFile {
		return "", nil, 0, workspaceConfinedError("workspace_file_unsupported", "workspace path is not a regular file")
	}
	before, err := inspectWorkspaceConfinedDarwinFD(file.fd)
	if err != nil || before.kind != workspaceConfinedKindFile || !sameWorkspaceConfinedDarwinObject(before, file) {
		return "", nil, 0, workspaceConfinedError("conflict_changed", "workspace file changed before reading")
	}
	if _, err := unix.Seek(file.fd, 0, ioSeekStart); err != nil {
		return "", nil, 0, workspaceConfinedError("workspace_file_unsupported", "workspace file cannot be read")
	}
	hasher := sha1.New()
	var content []byte
	if capture {
		initial, sizeErr := workspaceConfinedDarwinFileSize(before.stat)
		if sizeErr != nil {
			return "", nil, 0, sizeErr
		}
		if initial > maxCapture {
			capture = false
		} else {
			content = make([]byte, 0, int(initial))
		}
	}
	buffer := make([]byte, 64*1024)
	var total uint64
	for {
		count, readErr := unix.Read(file.fd, buffer)
		if count > 0 {
			chunk := buffer[:count]
			_, _ = hasher.Write(chunk)
			total += uint64(count)
			if capture {
				if total > maxCapture {
					capture = false
					content = nil
				} else {
					content = append(content, chunk...)
				}
			}
		}
		if readErr != nil {
			if errors.Is(readErr, unix.EINTR) {
				continue
			}
			return "", nil, 0, workspaceConfinedError("workspace_file_unsupported", "workspace file cannot be read")
		}
		if count == 0 {
			break
		}
	}
	after, err := inspectWorkspaceConfinedDarwinFD(file.fd)
	if err != nil || after.kind != workspaceConfinedKindFile || !sameWorkspaceConfinedDarwinFileObservation(before.stat, after.stat) || after.stat.Size < 0 || total != uint64(after.stat.Size) {
		return "", nil, 0, workspaceConfinedError("conflict_changed", "workspace file changed while reading")
	}
	return hex.EncodeToString(hasher.Sum(nil)), content, total, nil
}

const ioSeekStart = 0

func revalidateWorkspaceConfinedDarwinName(parent int, name string, expected workspaceConfinedDarwinHandle) error {
	var stat unix.Stat_t
	if err := unix.Fstatat(parent, name, &stat, unix.AT_SYMLINK_NOFOLLOW); err != nil {
		return err
	}
	kind, err := workspaceConfinedDarwinKind(stat.Mode)
	if err != nil {
		return err
	}
	observed := workspaceConfinedDarwinHandle{
		identity: workspaceConfinedDarwinIdentity{device: stat.Dev, inode: stat.Ino}, kind: kind,
	}
	if !sameWorkspaceConfinedDarwinObject(observed, expected) {
		return fmt.Errorf("workspace path name no longer identifies the held object")
	}
	return nil
}

func quarantineWorkspaceConfinedDarwinEntry(parent int, originalName string, expected workspaceConfinedDarwinHandle) (string, error) {
	for attempt := 0; attempt < 8; attempt++ {
		randomBytes := make([]byte, 16)
		if _, err := rand.Read(randomBytes); err != nil {
			return "", err
		}
		name := ".happier-conflict-quarantine-" + hex.EncodeToString(randomBytes)
		var existing unix.Stat_t
		if err := unix.Fstatat(parent, name, &existing, unix.AT_SYMLINK_NOFOLLOW); err == nil {
			continue
		} else if !errors.Is(err, unix.ENOENT) {
			return "", err
		}
		if err := revalidateWorkspaceConfinedDarwinName(parent, originalName, expected); err != nil {
			return "", err
		}
		if err := unix.Renameat(parent, originalName, parent, name); err != nil {
			return "", err
		}
		return name, nil
	}
	return "", fmt.Errorf("could not create a unique quarantine name")
}

func deleteWorkspaceConfinedDarwinTree(parent int, name string, target workspaceConfinedDarwinHandle) error {
	if target.kind == workspaceConfinedKindDirectory {
		duplicate, err := unix.Dup(target.fd)
		if err != nil {
			return err
		}
		unix.CloseOnExec(duplicate)
		// The dup shares the held directory offset; rewind past any earlier listing.
		if _, err := unix.Seek(duplicate, 0, 0); err != nil {
			_ = unix.Close(duplicate)
			return err
		}
		directory := os.NewFile(uintptr(duplicate), "workspace-confined-directory")
		entries, err := directory.ReadDir(-1)
		closeErr := directory.Close()
		if err != nil {
			return err
		}
		if closeErr != nil {
			return closeErr
		}
		for _, entry := range entries {
			childName := entry.Name()
			if childName == "" || childName == "." || childName == ".." || strings.Contains(childName, "/") || strings.IndexByte(childName, 0) >= 0 {
				return fmt.Errorf("unsafe directory entry name")
			}
			child, err := openWorkspaceConfinedDarwinComponent(target.fd, childName)
			if err != nil {
				if errors.Is(err, unix.ENOENT) {
					continue
				}
				return err
			}
			deleteErr := deleteWorkspaceConfinedDarwinTree(target.fd, childName, child)
			closeErr := unix.Close(child.fd)
			if deleteErr != nil {
				return deleteErr
			}
			if closeErr != nil {
				return closeErr
			}
		}
	}
	current, err := inspectWorkspaceConfinedDarwinFD(target.fd)
	if err != nil || !sameWorkspaceConfinedDarwinObject(current, target) {
		return fmt.Errorf("workspace entry changed before deletion")
	}
	if err := revalidateWorkspaceConfinedDarwinName(parent, name, target); err != nil {
		return err
	}
	flags := 0
	if target.kind == workspaceConfinedKindDirectory {
		flags = unix.AT_REMOVEDIR
	}
	return unix.Unlinkat(parent, name, flags)
}

func workspaceConfinedDarwinPhysicalPath(fd int) (string, error) {
	buffer := make([]byte, 4096)
	_, _, errno := unix.Syscall(
		unix.SYS_FCNTL,
		uintptr(fd),
		uintptr(unix.F_GETPATH),
		uintptr(unsafe.Pointer(&buffer[0])),
	)
	runtime.KeepAlive(buffer)
	if errno != 0 {
		return "", errno
	}
	end := bytes.IndexByte(buffer, 0)
	if end <= 0 {
		return "", fmt.Errorf("F_GETPATH returned an invalid path")
	}
	path := string(buffer[:end])
	if !filepath.IsAbs(path) {
		return "", fmt.Errorf("F_GETPATH returned a non-absolute path")
	}
	return path, nil
}
