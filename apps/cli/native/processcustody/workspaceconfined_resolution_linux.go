//go:build linux

package main

import (
	"crypto/sha1"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"

	"golang.org/x/sys/unix"
)

type workspaceConfinedLinuxHandle struct {
	fd   int
	dev  uint64
	ino  uint64
	kind workspaceConfinedKind
	stat unix.Stat_t
}
type workspaceConfinedLinuxPath struct {
	rootPath   string
	components []string
	handles    []workspaceConfinedLinuxHandle
	missing    bool
	// Read-side operations (read, delete, observe, capture) treat a missing
	// ancestor like a missing leaf, as Darwin and Windows do; apply keeps
	// requiring its parent directory.
	missingAncestorAllowed bool
}
type workspaceConfinedLinuxApplyOperation struct {
	path    *workspaceConfinedLinuxPath
	request workspaceConfinedApplyRequest
}
type workspaceConfinedLinuxRecoverOperation struct {
	root    workspaceConfinedLinuxHandle
	request workspaceConfinedRecoverRequest
}

func prepareWorkspaceConfinedApply(request workspaceConfinedApplyRequest) (workspaceConfinedPreparedOperation, *workspaceConfinedDomainError) {
	path, err := openWorkspaceConfinedLinuxPath(request.rootPath, request.relativePath)
	if err != nil {
		return nil, err
	}
	if _, domainErr := workspaceConfinedValidatePrivateDirectory(request.recoveryDirectory); domainErr != nil {
		path.close()
		return nil, domainErr
	}
	return &workspaceConfinedLinuxApplyOperation{path: path, request: request}, nil
}
func prepareWorkspaceConfinedRecover(request workspaceConfinedRecoverRequest) (workspaceConfinedPreparedOperation, *workspaceConfinedDomainError) {
	root, err := openWorkspaceConfinedLinuxRoot(request.rootPath)
	if err != nil {
		return nil, workspaceConfinedError("workspace_root_unsafe", "workspace root could not be opened safely")
	}
	if _, domainErr := workspaceConfinedValidatePrivateDirectory(request.recoveryDirectory); domainErr != nil {
		_ = unix.Close(root.fd)
		return nil, domainErr
	}
	return &workspaceConfinedLinuxRecoverOperation{root: root, request: request}, nil
}
func (o *workspaceConfinedLinuxApplyOperation) close()   { o.path.close() }
func (o *workspaceConfinedLinuxRecoverOperation) close() { _ = unix.Close(o.root.fd) }

func (o *workspaceConfinedLinuxApplyOperation) commit() workspaceConfinedResult {
	if err := o.path.revalidate(); err != nil {
		return err.result()
	}
	current, err := observeWorkspaceConfinedLinuxPath(o.path)
	if err != nil {
		return err.result()
	}
	if !workspaceConfinedExpectationsEqual(current, o.request.expectedDestination) {
		return workspaceConfinedError("conflict_changed", "workspace destination changed before apply").result()
	}
	if o.request.materialPath != nil {
		material, materialErr := observeWorkspaceConfinedPrivateMaterial(*o.request.materialPath)
		if materialErr != nil || !workspaceConfinedExpectationsEqual(material, o.request.selectedExpectation) {
			return workspaceConfinedError("conflict_changed", "captured workspace material changed before apply").result()
		}
	}
	parent := o.path.handles[len(o.path.handles)-1]
	var existing *workspaceConfinedLinuxHandle
	if !o.path.missing {
		parent = o.path.handles[len(o.path.handles)-2]
		value := o.path.handles[len(o.path.handles)-1]
		existing = &value
	}
	finalName := o.path.components[len(o.path.components)-1]
	parentPath, physicalErr := os.Readlink("/proc/self/fd/" + strconv.Itoa(parent.fd))
	if physicalErr != nil {
		return workspaceConfinedError("workspace_root_unsafe", "workspace destination parent could not be resolved").result()
	}
	candidateName := ".happier-conflict-resolution-" + o.request.operationID + "-selected"
	priorName := ".happier-conflict-resolution-" + o.request.operationID + "-prior"
	candidatePath := filepath.Join(parentPath, candidateName)
	priorPath := filepath.Join(parentPath, priorName)
	recordPath := workspaceConfinedRecoveryRecordPath(o.request.recoveryDirectory, o.request.operationID)
	for _, reserved := range []string{candidatePath, priorPath, recordPath} {
		if _, statErr := os.Lstat(reserved); !errors.Is(statErr, os.ErrNotExist) {
			return workspaceConfinedError("conflict_resolution_unsupported", "workspace recovery identity is already in use").result()
		}
	}
	record := workspaceConfinedRecoveryRecord{V: 1, OperationID: o.request.operationID, RootPath: o.path.rootPath, RootIdentity: linuxWorkspaceConfinedIdentity(o.path.handles[0]), RelativePath: o.request.relativePath, ExpectedDestination: o.request.expectedDestination, SelectedExpectation: o.request.selectedExpectation, CandidateName: candidateName, PriorName: priorName}
	if err := workspaceConfinedWriteRecoveryRecord(recordPath, record); err != nil {
		return workspaceConfinedError("conflict_resolution_unsupported", "workspace recovery evidence could not be retained").result()
	}
	if o.request.materialPath != nil {
		if err := copyWorkspaceConfinedPrivateMaterial(*o.request.materialPath, candidatePath); err != nil {
			return workspaceConfinedRecoveryNeeded(candidatePath)
		}
		candidate, openErr := openWorkspaceConfinedLinuxAt(parent.fd, candidateName)
		if openErr != nil {
			return workspaceConfinedRecoveryNeeded(candidatePath)
		}
		candidateExpectation, observeErr := observeWorkspaceConfinedLinuxEntry(parent.fd, candidateName, candidate)
		_ = unix.Close(candidate.fd)
		if observeErr != nil || !workspaceConfinedExpectationsEqual(candidateExpectation, o.request.selectedExpectation) {
			return workspaceConfinedRecoveryNeeded(candidatePath)
		}
	}
	if existing != nil {
		if err := unix.Renameat2(parent.fd, finalName, parent.fd, priorName, unix.RENAME_NOREPLACE); err != nil {
			return workspaceConfinedRecoveryNeeded(recordPath)
		}
	}
	if o.request.selectedExpectation.Kind != workspaceConfinedKindMissing {
		if err := unix.Renameat2(parent.fd, candidateName, parent.fd, finalName, unix.RENAME_NOREPLACE); err != nil {
			if restoreWorkspaceConfinedLinuxPrior(parent.fd, finalName, priorName, existing != nil) {
				if !workspaceConfinedDisplacedMatchesOrWasCleaned(candidatePath, o.request.selectedExpectation) || removeWorkspaceConfinedLinuxNamedEntry(parent.fd, candidateName) != nil {
					return workspaceConfinedRecoveryNeeded(candidatePath)
				}
				if err := os.Remove(recordPath); err != nil {
					return workspaceConfinedRecoveryNeeded(recordPath)
				}
				return workspaceConfinedSuccess("restored")
			}
			return workspaceConfinedRecoveryNeeded(priorPath)
		}
	}
	public, publicErr := openWorkspaceConfinedLinuxAt(parent.fd, finalName)
	if o.request.selectedExpectation.Kind == workspaceConfinedKindMissing {
		if publicErr == nil {
			_ = unix.Close(public.fd)
			return workspaceConfinedRecoveryNeeded(priorPath)
		}
		if !errors.Is(publicErr, unix.ENOENT) {
			return workspaceConfinedRecoveryNeeded(priorPath)
		}
	} else {
		if publicErr != nil {
			return workspaceConfinedRecoveryNeeded(priorPath)
		}
		installed, observeErr := observeWorkspaceConfinedLinuxEntry(parent.fd, finalName, public)
		_ = unix.Close(public.fd)
		if observeErr != nil || !workspaceConfinedExpectationsEqual(installed, o.request.selectedExpectation) {
			return workspaceConfinedRecoveryNeeded(priorPath)
		}
	}
	if existing != nil {
		if !workspaceConfinedDisplacedMatches(priorPath, o.request.expectedDestination) {
			return workspaceConfinedRecoveryNeeded(priorPath)
		}
		if err := removeWorkspaceConfinedLinuxNamedEntry(parent.fd, priorName); err != nil {
			return workspaceConfinedRecoveryNeeded(priorPath)
		}
	}
	if !workspaceConfinedDisplacedMatchesOrWasCleaned(candidatePath, o.request.selectedExpectation) || removeWorkspaceConfinedLinuxNamedEntry(parent.fd, candidateName) != nil {
		return workspaceConfinedRecoveryNeeded(candidatePath)
	}
	if err := os.Remove(recordPath); err != nil {
		return workspaceConfinedRecoveryNeeded(recordPath)
	}
	return workspaceConfinedSuccess("installed")
}
func (o *workspaceConfinedLinuxRecoverOperation) commit() workspaceConfinedResult {
	recordPath := workspaceConfinedRecoveryRecordPath(o.request.recoveryDirectory, o.request.operationID)
	record, err := workspaceConfinedReadRecoveryRecord(recordPath)
	if errors.Is(err, os.ErrNotExist) {
		return workspaceConfinedSuccess("settled")
	}
	if err != nil || record.OperationID != o.request.operationID || filepath.Clean(record.RootPath) != filepath.Clean(o.request.rootPath) || record.RootIdentity != linuxWorkspaceConfinedIdentity(o.root) {
		return workspaceConfinedRecoveryNeeded(recordPath)
	}
	path, domainErr := openWorkspaceConfinedLinuxPath(o.request.rootPath, record.RelativePath)
	if domainErr != nil {
		return workspaceConfinedRecoveryNeeded(recordPath)
	}
	defer path.close()
	parent := path.handles[len(path.handles)-1]
	if !path.missing {
		parent = path.handles[len(path.handles)-2]
	}
	finalName := path.components[len(path.components)-1]
	public, observeErr := observeWorkspaceConfinedLinuxPath(path)
	if observeErr != nil {
		return workspaceConfinedRecoveryNeeded(recordPath)
	}
	parentPath, pathErr := os.Readlink("/proc/self/fd/" + strconv.Itoa(parent.fd))
	if pathErr != nil {
		return workspaceConfinedRecoveryNeeded(recordPath)
	}
	priorPath := filepath.Join(parentPath, record.PriorName)
	candidatePath := filepath.Join(parentPath, record.CandidateName)
	if workspaceConfinedExpectationsEqual(public, record.SelectedExpectation) {
		if !workspaceConfinedDisplacedMatchesOrWasCleaned(priorPath, record.ExpectedDestination) {
			return workspaceConfinedRecoveryNeeded(priorPath)
		}
		if !workspaceConfinedDisplacedMatchesOrWasCleaned(candidatePath, record.SelectedExpectation) || removeWorkspaceConfinedLinuxNamedEntry(parent.fd, record.CandidateName) != nil {
			return workspaceConfinedRecoveryNeeded(candidatePath)
		}
		if err := removeWorkspaceConfinedLinuxNamedEntry(parent.fd, record.PriorName); err != nil && !errors.Is(err, os.ErrNotExist) {
			return workspaceConfinedRecoveryNeeded(priorPath)
		}
		if err := os.Remove(recordPath); err != nil {
			return workspaceConfinedRecoveryNeeded(recordPath)
		}
		return workspaceConfinedSuccess("settled")
	}
	if workspaceConfinedExpectationsEqual(public, record.ExpectedDestination) {
		if !workspaceConfinedDisplacedMatchesOrWasCleaned(candidatePath, record.SelectedExpectation) || removeWorkspaceConfinedLinuxNamedEntry(parent.fd, record.CandidateName) != nil {
			return workspaceConfinedRecoveryNeeded(candidatePath)
		}
		if err := os.Remove(recordPath); err != nil {
			return workspaceConfinedRecoveryNeeded(recordPath)
		}
		return workspaceConfinedSuccess("settled")
	}
	if public.Kind != workspaceConfinedKindMissing {
		return workspaceConfinedRecoveryNeeded(priorPath)
	}
	if record.SelectedExpectation.Kind == workspaceConfinedKindMissing {
		if !workspaceConfinedDisplacedMatches(priorPath, record.ExpectedDestination) {
			return workspaceConfinedRecoveryNeeded(priorPath)
		}
		if err := removeWorkspaceConfinedLinuxNamedEntry(parent.fd, record.PriorName); err != nil && !errors.Is(err, os.ErrNotExist) {
			return workspaceConfinedRecoveryNeeded(priorPath)
		}
		if !workspaceConfinedDisplacedMatchesOrWasCleaned(candidatePath, record.SelectedExpectation) || removeWorkspaceConfinedLinuxNamedEntry(parent.fd, record.CandidateName) != nil {
			return workspaceConfinedRecoveryNeeded(candidatePath)
		}
		if err := os.Remove(recordPath); err != nil {
			return workspaceConfinedRecoveryNeeded(recordPath)
		}
		return workspaceConfinedSuccess("settled")
	}
	if candidate, err := openWorkspaceConfinedLinuxAt(parent.fd, record.CandidateName); err == nil {
		candidateExpectation, observeErr := observeWorkspaceConfinedLinuxEntry(parent.fd, record.CandidateName, candidate)
		_ = unix.Close(candidate.fd)
		if observeErr == nil && workspaceConfinedExpectationsEqual(candidateExpectation, record.SelectedExpectation) && workspaceConfinedDisplacedMatches(priorPath, record.ExpectedDestination) && unix.Renameat2(parent.fd, record.CandidateName, parent.fd, finalName, unix.RENAME_NOREPLACE) == nil {
			if err := removeWorkspaceConfinedLinuxNamedEntry(parent.fd, record.PriorName); err != nil && !errors.Is(err, os.ErrNotExist) {
				return workspaceConfinedRecoveryNeeded(priorPath)
			}
			if err := os.Remove(recordPath); err != nil {
				return workspaceConfinedRecoveryNeeded(recordPath)
			}
			return workspaceConfinedSuccess("settled")
		}
	}
	if workspaceConfinedDisplacedMatches(priorPath, record.ExpectedDestination) && restoreWorkspaceConfinedLinuxPrior(parent.fd, finalName, record.PriorName, true) {
		if !workspaceConfinedDisplacedMatchesOrWasCleaned(candidatePath, record.SelectedExpectation) || removeWorkspaceConfinedLinuxNamedEntry(parent.fd, record.CandidateName) != nil {
			return workspaceConfinedRecoveryNeeded(candidatePath)
		}
		if err := os.Remove(recordPath); err != nil {
			return workspaceConfinedRecoveryNeeded(recordPath)
		}
		return workspaceConfinedSuccess("settled")
	}
	return workspaceConfinedRecoveryNeeded(priorPath)
}

func validateWorkspaceConfinedLinuxRelativePath(path string) ([]string, *workspaceConfinedDomainError) {
	if path == "" || filepath.IsAbs(path) || strings.IndexByte(path, 0) >= 0 {
		return nil, workspaceConfinedError("workspace_root_unsafe", "workspace path is not safe")
	}
	parts := strings.Split(path, "/")
	for _, part := range parts {
		if part == "" || part == "." || part == ".." {
			return nil, workspaceConfinedError("workspace_root_unsafe", "workspace path contains an unsafe component")
		}
	}
	return parts, nil
}
func openWorkspaceConfinedLinuxRoot(rootPath string) (workspaceConfinedLinuxHandle, error) {
	if rootPath == "" || !filepath.IsAbs(rootPath) {
		return workspaceConfinedLinuxHandle{}, fmt.Errorf("root must be absolute")
	}
	fd, err := unix.Open(filepath.Clean(rootPath), unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return workspaceConfinedLinuxHandle{}, err
	}
	handle, err := inspectWorkspaceConfinedLinuxFD(fd)
	if err != nil || handle.kind != workspaceConfinedKindDirectory {
		_ = unix.Close(fd)
		return workspaceConfinedLinuxHandle{}, fmt.Errorf("root is not directory")
	}
	return handle, nil
}
func openWorkspaceConfinedLinuxAt(parent int, name string) (workspaceConfinedLinuxHandle, error) {
	var stat unix.Stat_t
	if err := unix.Fstatat(parent, name, &stat, unix.AT_SYMLINK_NOFOLLOW); err != nil {
		return workspaceConfinedLinuxHandle{}, err
	}
	kind, err := workspaceConfinedLinuxKind(stat.Mode)
	if err != nil {
		return workspaceConfinedLinuxHandle{}, err
	}
	flags := unix.O_RDONLY | unix.O_CLOEXEC | unix.O_NOFOLLOW
	if kind == workspaceConfinedKindDirectory {
		flags |= unix.O_DIRECTORY
	}
	if kind == workspaceConfinedKindSymlink {
		flags = unix.O_PATH | unix.O_CLOEXEC | unix.O_NOFOLLOW
	}
	fd, err := unix.Openat(parent, name, flags, 0)
	if err != nil {
		return workspaceConfinedLinuxHandle{}, err
	}
	handle, err := inspectWorkspaceConfinedLinuxFD(fd)
	if err != nil || handle.dev != uint64(stat.Dev) || handle.ino != stat.Ino || handle.kind != kind {
		_ = unix.Close(fd)
		return workspaceConfinedLinuxHandle{}, fmt.Errorf("entry changed")
	}
	return handle, nil
}
func inspectWorkspaceConfinedLinuxFD(fd int) (workspaceConfinedLinuxHandle, error) {
	var stat unix.Stat_t
	if err := unix.Fstat(fd, &stat); err != nil {
		return workspaceConfinedLinuxHandle{}, err
	}
	kind, err := workspaceConfinedLinuxKind(stat.Mode)
	if err != nil {
		return workspaceConfinedLinuxHandle{}, err
	}
	return workspaceConfinedLinuxHandle{fd: fd, dev: uint64(stat.Dev), ino: stat.Ino, kind: kind, stat: stat}, nil
}
func workspaceConfinedLinuxKind(mode uint32) (workspaceConfinedKind, error) {
	switch mode & unix.S_IFMT {
	case unix.S_IFREG:
		return workspaceConfinedKindFile, nil
	case unix.S_IFDIR:
		return workspaceConfinedKindDirectory, nil
	case unix.S_IFLNK:
		return workspaceConfinedKindSymlink, nil
	default:
		return "", fmt.Errorf("unsupported type")
	}
}
func openWorkspaceConfinedLinuxPath(rootPath, relativePath string) (*workspaceConfinedLinuxPath, *workspaceConfinedDomainError) {
	return openWorkspaceConfinedLinuxPathMode(rootPath, relativePath, false)
}
func openWorkspaceConfinedLinuxReadPath(rootPath, relativePath string) (*workspaceConfinedLinuxPath, *workspaceConfinedDomainError) {
	return openWorkspaceConfinedLinuxPathMode(rootPath, relativePath, true)
}
func openWorkspaceConfinedLinuxPathMode(rootPath, relativePath string, missingAncestorAllowed bool) (*workspaceConfinedLinuxPath, *workspaceConfinedDomainError) {
	parts, domainErr := validateWorkspaceConfinedLinuxRelativePath(relativePath)
	if domainErr != nil {
		return nil, domainErr
	}
	root, err := openWorkspaceConfinedLinuxRoot(rootPath)
	if err != nil {
		return nil, workspaceConfinedError("workspace_root_unsafe", "workspace root could not be opened safely")
	}
	path := &workspaceConfinedLinuxPath{rootPath: filepath.Clean(rootPath), components: parts, handles: []workspaceConfinedLinuxHandle{root},
		missingAncestorAllowed: missingAncestorAllowed}
	parent := root.fd
	for index, part := range parts {
		child, err := openWorkspaceConfinedLinuxAt(parent, part)
		if errors.Is(err, unix.ENOENT) && (index == len(parts)-1 || missingAncestorAllowed) {
			path.missing = true
			return path, nil
		}
		if err != nil {
			path.close()
			return nil, workspaceConfinedError("workspace_root_unsafe", "workspace path could not be opened safely")
		}
		if index < len(parts)-1 && child.kind != workspaceConfinedKindDirectory {
			_ = unix.Close(child.fd)
			path.close()
			return nil, workspaceConfinedError("workspace_root_unsafe", "workspace path traverses a non-directory")
		}
		path.handles = append(path.handles, child)
		parent = child.fd
	}
	return path, nil
}
func (p *workspaceConfinedLinuxPath) close() {
	for i := len(p.handles) - 1; i >= 0; i-- {
		_ = unix.Close(p.handles[i].fd)
	}
}
func (p *workspaceConfinedLinuxPath) revalidate() *workspaceConfinedDomainError {
	current, err := openWorkspaceConfinedLinuxPathMode(p.rootPath, strings.Join(p.components, "/"), p.missingAncestorAllowed)
	if err != nil {
		// The path was safe at prepare; any refusal now means it changed (as on Darwin).
		return workspaceConfinedError("conflict_changed", "workspace path changed before commit")
	}
	defer current.close()
	if current.missing != p.missing || len(current.handles) != len(p.handles) {
		return workspaceConfinedError("conflict_changed", "workspace path changed before commit")
	}
	for i := range p.handles {
		if p.handles[i].dev != current.handles[i].dev || p.handles[i].ino != current.handles[i].ino || p.handles[i].kind != current.handles[i].kind {
			return workspaceConfinedError("conflict_changed", "workspace path changed before commit")
		}
	}
	return nil
}
func linuxWorkspaceConfinedIdentity(handle workspaceConfinedLinuxHandle) string {
	return strconv.FormatUint(handle.dev, 10) + ":" + strconv.FormatUint(handle.ino, 10)
}

func observeWorkspaceConfinedLinuxPath(path *workspaceConfinedLinuxPath) (workspaceConfinedExpectation, *workspaceConfinedDomainError) {
	if path.missing {
		return workspaceConfinedExpectation{Kind: workspaceConfinedKindMissing}, nil
	}
	parent := path.handles[len(path.handles)-2]
	final := path.handles[len(path.handles)-1]
	return observeWorkspaceConfinedLinuxEntry(parent.fd, path.components[len(path.components)-1], final)
}
func observeWorkspaceConfinedLinuxEntry(parent int, name string, entry workspaceConfinedLinuxHandle) (workspaceConfinedExpectation, *workspaceConfinedDomainError) {
	return observeWorkspaceConfinedLinuxEntryMode(parent, name, entry, nil)
}

// One traversal owns both complete effect expectations and passive metadata-only measurements.
func observeWorkspaceConfinedLinuxEntryMode(parent int, name string, entry workspaceConfinedLinuxHandle, measurement *uint64) (workspaceConfinedExpectation, *workspaceConfinedDomainError) {
	current, err := inspectWorkspaceConfinedLinuxFD(entry.fd)
	if err != nil || current.dev != entry.dev || current.ino != entry.ino || current.kind != entry.kind {
		return workspaceConfinedExpectation{}, workspaceConfinedError("conflict_changed", "workspace entry changed during observation")
	}
	switch entry.kind {
	case workspaceConfinedKindFile:
		if measurement != nil {
			if current.stat.Size < 0 {
				return workspaceConfinedExpectation{}, workspaceConfinedError("workspace_file_unsupported", "workspace file size cannot be represented")
			}
			return workspaceConfinedExpectation{}, addWorkspaceConfinedMeasuredBytes(measurement, uint64(current.stat.Size))
		}
		if _, err := unix.Seek(entry.fd, 0, 0); err != nil {
			return workspaceConfinedExpectation{}, workspaceConfinedError("workspace_file_unsupported", "file cannot be read")
		}
		hasher := sha1.New()
		size, err := hasherReadLinuxFile(entry.fd, hasher)
		if err != nil {
			return workspaceConfinedExpectation{}, workspaceConfinedError("workspace_file_unsupported", "file cannot be read")
		}
		after, err := inspectWorkspaceConfinedLinuxFD(entry.fd)
		if err != nil || after.stat.Size != current.stat.Size || after.stat.Mtim != current.stat.Mtim || size != after.stat.Size {
			return workspaceConfinedExpectation{}, workspaceConfinedError("conflict_changed", "file changed while reading")
		}
		executable := after.stat.Mode&0o111 != 0
		safeSize := uint64(size)
		return workspaceConfinedExpectation{Kind: entry.kind, Digest: hex.EncodeToString(hasher.Sum(nil)), Executable: &executable, Size: &safeSize}, nil
	case workspaceConfinedKindSymlink:
		if measurement != nil {
			return workspaceConfinedExpectation{}, nil
		}
		buffer := make([]byte, 4096)
		count, err := unix.Readlinkat(parent, name, buffer)
		if err != nil {
			return workspaceConfinedExpectation{}, workspaceConfinedError("workspace_file_unsupported", "symlink cannot be read")
		}
		if !utf8.Valid(buffer[:count]) {
			return workspaceConfinedExpectation{}, workspaceConfinedError("workspace_file_unsupported", "symlink target cannot be represented")
		}
		return workspaceConfinedExpectation{Kind: entry.kind, Target: string(buffer[:count])}, nil
	case workspaceConfinedKindDirectory:
		names, err := listWorkspaceConfinedLinuxDirectory(entry.fd)
		if err != nil {
			return workspaceConfinedExpectation{}, workspaceConfinedError("workspace_file_unsupported", "directory cannot be observed completely")
		}
		fingerprint := newWorkspaceConfinedFingerprintWriter()
		for _, childName := range names {
			child, err := openWorkspaceConfinedLinuxAt(entry.fd, childName)
			if err != nil {
				return workspaceConfinedExpectation{}, workspaceConfinedError("conflict_changed", "directory changed during observation")
			}
			childExpectation, childErr := observeWorkspaceConfinedLinuxEntryMode(entry.fd, childName, child, measurement)
			_ = unix.Close(child.fd)
			if childErr != nil {
				return workspaceConfinedExpectation{}, childErr
			}
			if measurement == nil {
				fingerprint.add(childName, childExpectation)
			}
		}
		unchanged := workspaceConfinedLinuxDirectoryUnchanged(entry.fd, current, names)
		var named unix.Stat_t
		nameErr := unix.Fstatat(parent, name, &named, unix.AT_SYMLINK_NOFOLLOW)
		if !unchanged || nameErr != nil ||
			uint64(named.Dev) != current.dev || named.Ino != current.ino || named.Mode&unix.S_IFMT != unix.S_IFDIR {
			return workspaceConfinedExpectation{}, workspaceConfinedError("conflict_changed", "directory changed during observation")
		}
		if measurement != nil {
			return workspaceConfinedExpectation{}, nil
		}
		return workspaceConfinedExpectation{Kind: entry.kind, Fingerprint: fingerprint.finish()}, nil
	}
	return workspaceConfinedExpectation{}, workspaceConfinedError("workspace_file_unsupported", "unsupported entry")
}
func workspaceConfinedLinuxDirectoryUnchanged(fd int, before workspaceConfinedLinuxHandle, names []string) bool {
	afterNames, err := listWorkspaceConfinedLinuxDirectory(fd)
	if err != nil || !slices.Equal(names, afterNames) {
		return false
	}
	after, err := inspectWorkspaceConfinedLinuxFD(fd)
	return err == nil && after.dev == before.dev && after.ino == before.ino && after.kind == before.kind &&
		after.stat.Mtim == before.stat.Mtim && after.stat.Ctim == before.stat.Ctim
}
func hasherReadLinuxFile(fd int, hasher interface{ Write([]byte) (int, error) }) (int64, error) {
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
func listWorkspaceConfinedLinuxDirectory(fd int) ([]string, error) {
	duplicate, err := unix.Dup(fd)
	if err != nil {
		return nil, err
	}
	if _, err := unix.Seek(duplicate, 0, 0); err != nil {
		_ = unix.Close(duplicate)
		return nil, err
	}
	directory := os.NewFile(uintptr(duplicate), "workspace-directory")
	entries, readErr := directory.ReadDir(-1)
	closeErr := directory.Close()
	if readErr != nil {
		return nil, readErr
	}
	if closeErr != nil {
		return nil, closeErr
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		name := entry.Name()
		if name == "" || name == "." || name == ".." || strings.Contains(name, "/") || !utf8.ValidString(name) {
			return nil, fmt.Errorf("unsafe name")
		}
		names = append(names, name)
	}
	sort.Strings(names)
	return names, nil
}
func removeWorkspaceConfinedLinuxNamedEntry(parent int, name string) error {
	path := "/proc/self/fd/" + strconv.Itoa(parent) + "/" + name
	return removeWorkspaceConfinedPrivateMaterial(path)
}
func restoreWorkspaceConfinedLinuxPrior(parent int, finalName, priorName string, hasPrior bool) bool {
	if !hasPrior {
		return true
	}
	return unix.Renameat2(parent, priorName, parent, finalName, unix.RENAME_NOREPLACE) == nil
}
