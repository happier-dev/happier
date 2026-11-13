//go:build linux

package main

import (
	"crypto/rand"
	"crypto/sha1"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"

	"golang.org/x/sys/unix"
)

// Linux read, delete, observe and capture: the same two-phase contract and
// held-handle confinement as Darwin and Windows, over the Linux handle chain in
// workspaceconfined_resolution_linux.go (O_NOFOLLOW per component, dev/ino
// identity, renameat2 RENAME_NOREPLACE). A Linux host keeps its TypeScript
// retained-descriptor path; these serve targets without the CLI (containers,
// sandboxes) through the per-Session holder.

type workspaceConfinedLinuxReadOperation struct {
	path    *workspaceConfinedLinuxPath
	request workspaceConfinedReadRequest
}

type workspaceConfinedLinuxDeleteOperation struct {
	path              *workspaceConfinedLinuxPath
	request           workspaceConfinedDeleteRequest
	preconditionError *workspaceConfinedDomainError
}

type workspaceConfinedLinuxObserveOperation struct {
	path        *workspaceConfinedLinuxPath
	measureSize bool
}

type workspaceConfinedLinuxCaptureOperation struct {
	path    *workspaceConfinedLinuxPath
	request workspaceConfinedCaptureRequest
}

func (p *workspaceConfinedLinuxPath) final() workspaceConfinedLinuxHandle {
	return p.handles[len(p.handles)-1]
}

func (p *workspaceConfinedLinuxPath) parentNameTarget() (workspaceConfinedLinuxHandle, string, *workspaceConfinedLinuxHandle) {
	name := p.components[len(p.components)-1]
	if p.missing {
		return p.handles[len(p.handles)-1], name, nil
	}
	target := p.handles[len(p.handles)-1]
	return p.handles[len(p.handles)-2], name, &target
}

func prepareWorkspaceConfinedRead(request workspaceConfinedReadRequest) (workspaceConfinedPreparedOperation, *workspaceConfinedDomainError) {
	path, domainErr := openWorkspaceConfinedLinuxReadPath(request.rootPath, request.relativePath)
	if domainErr != nil {
		return nil, domainErr
	}
	if !path.missing && path.final().kind == workspaceConfinedKindFile && request.expectedDigest != "" {
		if _, _, _, domainErr := readWorkspaceConfinedLinuxFile(path.final(), false, 0); domainErr != nil {
			path.close()
			return nil, domainErr
		}
	}
	return &workspaceConfinedLinuxReadOperation{path: path, request: request}, nil
}

func prepareWorkspaceConfinedDelete(request workspaceConfinedDeleteRequest) (workspaceConfinedPreparedOperation, *workspaceConfinedDomainError) {
	path, domainErr := openWorkspaceConfinedLinuxReadPath(request.rootPath, request.relativePath)
	if domainErr != nil {
		return nil, domainErr
	}
	operation := &workspaceConfinedLinuxDeleteOperation{path: path, request: request}
	actualKind := workspaceConfinedKindMissing
	if !path.missing {
		actualKind = path.final().kind
	}
	if actualKind != request.expectedKind {
		operation.preconditionError = workspaceConfinedError("conflict_changed", "conflict loser type changed")
		return operation, nil
	}
	if request.expectedKind == workspaceConfinedKindFile {
		digest, _, _, digestErr := readWorkspaceConfinedLinuxFile(path.final(), false, 0)
		if digestErr != nil {
			path.close()
			return nil, digestErr
		}
		if digest != request.expectedDigest {
			operation.preconditionError = workspaceConfinedError("conflict_changed", "conflict loser digest changed")
		}
	}
	return operation, nil
}

func prepareWorkspaceConfinedObserve(request workspaceConfinedObserveRequest) (workspaceConfinedPreparedOperation, *workspaceConfinedDomainError) {
	path, err := openWorkspaceConfinedLinuxReadPath(request.rootPath, request.relativePath)
	if err != nil {
		return nil, err
	}
	return &workspaceConfinedLinuxObserveOperation{path: path, measureSize: request.measureSize}, nil
}

func prepareWorkspaceConfinedCapture(request workspaceConfinedCaptureRequest) (workspaceConfinedPreparedOperation, *workspaceConfinedDomainError) {
	path, err := openWorkspaceConfinedLinuxReadPath(request.rootPath, request.relativePath)
	if err != nil {
		return nil, err
	}
	if _, err := workspaceConfinedValidatePrivateDirectory(request.captureDirectory); err != nil {
		path.close()
		return nil, err
	}
	return &workspaceConfinedLinuxCaptureOperation{path: path, request: request}, nil
}

func (o *workspaceConfinedLinuxReadOperation) close()    { o.path.close() }
func (o *workspaceConfinedLinuxDeleteOperation) close()  { o.path.close() }
func (o *workspaceConfinedLinuxObserveOperation) close() { o.path.close() }
func (o *workspaceConfinedLinuxCaptureOperation) close() { o.path.close() }

func (o *workspaceConfinedLinuxReadOperation) commit() workspaceConfinedResult {
	if domainErr := o.path.revalidate(); domainErr != nil {
		return domainErr.result()
	}
	if o.path.missing {
		return workspaceConfinedSuccess("missing")
	}
	final := o.path.final()
	if final.kind != workspaceConfinedKindFile {
		return workspaceConfinedError("workspace_file_unsupported", "workspace preview supports only regular files").result()
	}
	current, err := inspectWorkspaceConfinedLinuxFD(final.fd)
	if err != nil || current.dev != final.dev || current.ino != final.ino || current.kind != workspaceConfinedKindFile {
		return workspaceConfinedError("conflict_changed", "workspace file changed before reading").result()
	}
	if current.stat.Size < 0 {
		return workspaceConfinedError("workspace_file_unsupported", "workspace file size is invalid").result()
	}
	size := uint64(current.stat.Size)
	if size > workspaceConfinedMaxSafeJSONInteger {
		return workspaceConfinedError("workspace_file_unsupported", "workspace file size is not representable").result()
	}
	maxBytes := uint64(o.request.maxBytes)
	if size > maxBytes && o.request.expectedDigest == "" {
		return workspaceConfinedResult{V: 1, T: "workspace-confined-result", Status: "too_large", Size: workspaceConfinedUint64(size)}
	}
	digest, content, currentSize, readErr := readWorkspaceConfinedLinuxFile(final, size <= maxBytes, maxBytes)
	if readErr != nil {
		return readErr.result()
	}
	if o.request.expectedDigest != "" && digest != o.request.expectedDigest {
		return workspaceConfinedResult{V: 1, T: "workspace-confined-result", Status: "changed", ActualDigest: digest}
	}
	if currentSize > maxBytes {
		return workspaceConfinedResult{V: 1, T: "workspace-confined-result", Status: "too_large", Size: workspaceConfinedUint64(currentSize), Digest: digest}
	}
	return workspaceConfinedResult{
		V: 1, T: "workspace-confined-result", Status: "content", Size: workspaceConfinedUint64(currentSize), Digest: digest,
		ContentBase64: workspaceConfinedString(base64.StdEncoding.EncodeToString(content)),
	}
}

func (o *workspaceConfinedLinuxDeleteOperation) commit() workspaceConfinedResult {
	if domainErr := o.path.revalidate(); domainErr != nil {
		return domainErr.result()
	}
	if o.preconditionError != nil {
		return o.preconditionError.result()
	}
	if o.request.expectedKind == workspaceConfinedKindMissing {
		return workspaceConfinedSuccess("deleted")
	}
	parent, finalName, target := o.path.parentNameTarget()
	final := *target
	current, err := inspectWorkspaceConfinedLinuxFD(final.fd)
	if err != nil || current.dev != final.dev || current.ino != final.ino || current.kind != o.request.expectedKind {
		return workspaceConfinedError("conflict_changed", "conflict loser type changed").result()
	}
	if o.request.expectedKind == workspaceConfinedKindFile {
		digest, _, _, digestErr := readWorkspaceConfinedLinuxFile(final, false, 0)
		if digestErr != nil {
			return digestErr.result()
		}
		if digest != o.request.expectedDigest {
			return workspaceConfinedError("conflict_changed", "conflict loser digest changed").result()
		}
	}
	parentPath, err := workspaceConfinedLinuxPhysicalPath(parent.fd)
	if err != nil {
		return workspaceConfinedError("workspace_root_unsafe", "could not resolve the conflict recovery directory").result()
	}
	quarantineName, err := quarantineWorkspaceConfinedLinuxEntry(parent.fd, finalName, final)
	if err != nil {
		return workspaceConfinedError("conflict_changed", "conflict loser changed before quarantine").result()
	}
	recoveryPath := filepath.Join(parentPath, quarantineName)
	quarantined, err := openWorkspaceConfinedLinuxAt(parent.fd, quarantineName)
	if err != nil || quarantined.dev != final.dev || quarantined.ino != final.ino || quarantined.kind != final.kind {
		if err == nil {
			_ = unix.Close(quarantined.fd)
		}
		return workspaceConfinedRecoveryError("conflict_changed",
			"conflict loser could not be safely reopened; recovery material remains quarantined", recoveryPath).result()
	}
	deleteErr := deleteWorkspaceConfinedLinuxTree(parent.fd, quarantineName, quarantined)
	closeErr := unix.Close(quarantined.fd)
	if deleteErr != nil || closeErr != nil {
		return workspaceConfinedRecoveryError("conflict_changed",
			"conflict loser could not be safely finalized; recovery material remains quarantined", recoveryPath).result()
	}
	return workspaceConfinedSuccess("deleted")
}

func (o *workspaceConfinedLinuxObserveOperation) commit() workspaceConfinedResult {
	if err := o.path.revalidate(); err != nil {
		return err.result()
	}
	var sizeBytes uint64
	var measurement *uint64
	if o.measureSize {
		measurement = &sizeBytes
	}
	expectation, err := observeWorkspaceConfinedLinuxPathMode(o.path, measurement)
	if err != nil {
		return err.result()
	}
	if o.measureSize {
		if err := o.path.revalidate(); err != nil {
			return err.result()
		}
		return workspaceConfinedMeasuredResult(sizeBytes)
	}
	return workspaceConfinedObservedResult(expectation)
}

func (o *workspaceConfinedLinuxCaptureOperation) commit() workspaceConfinedResult {
	if err := o.path.revalidate(); err != nil {
		return err.result()
	}
	observed, err := observeWorkspaceConfinedLinuxPathMode(o.path, nil)
	if err != nil {
		return err.result()
	}
	if !workspaceConfinedExpectationsEqual(observed, o.request.expected) {
		return workspaceConfinedError("conflict_changed", "workspace source changed before capture").result()
	}
	if observed.Kind == workspaceConfinedKindMissing {
		return workspaceConfinedCapturedResult(observed, nil)
	}
	materialPath := workspaceConfinedMaterialPath(o.request.captureDirectory, o.request.operationID)
	if _, err := os.Lstat(materialPath); !errors.Is(err, os.ErrNotExist) {
		return workspaceConfinedError("conflict_resolution_unsupported", "capture material path already exists").result()
	}
	parent, name, target := o.path.parentNameTarget()
	if target == nil {
		return workspaceConfinedError("conflict_changed", "workspace source disappeared before capture").result()
	}
	if err := copyWorkspaceConfinedLinuxHandle(parent.fd, name, *target, materialPath); err != nil {
		_ = removeWorkspaceConfinedPrivateMaterial(materialPath)
		return workspaceConfinedError("workspace_file_unsupported", "workspace entry could not be captured completely").result()
	}
	materialExpectation, materialErr := observeWorkspaceConfinedPrivateMaterial(materialPath)
	current, currentErr := observeWorkspaceConfinedLinuxPathMode(o.path, nil)
	if materialErr != nil || currentErr != nil || !workspaceConfinedExpectationsEqual(materialExpectation, observed) || !workspaceConfinedExpectationsEqual(current, observed) {
		_ = removeWorkspaceConfinedPrivateMaterial(materialPath)
		return workspaceConfinedError("conflict_changed", "workspace source changed during capture").result()
	}
	return workspaceConfinedCapturedResult(observed, &materialPath)
}

func observeWorkspaceConfinedLinuxPathMode(path *workspaceConfinedLinuxPath, measurement *uint64) (workspaceConfinedExpectation, *workspaceConfinedDomainError) {
	if path.missing {
		if measurement != nil {
			return workspaceConfinedExpectation{}, workspaceConfinedError("conflict_changed", "workspace entry disappeared during measurement")
		}
		return workspaceConfinedExpectation{Kind: workspaceConfinedKindMissing}, nil
	}
	parent, name, target := path.parentNameTarget()
	return observeWorkspaceConfinedLinuxEntryMode(parent.fd, name, *target, measurement)
}

func sameWorkspaceConfinedLinuxFileObservation(first, second unix.Stat_t) bool {
	return first.Dev == second.Dev && first.Ino == second.Ino && first.Mode == second.Mode &&
		first.Size == second.Size && first.Mtim == second.Mtim && first.Ctim == second.Ctim
}

// Digest (and optionally content up to maxCapture) of a held regular file; any
// change during the read is a conflict.
func readWorkspaceConfinedLinuxFile(file workspaceConfinedLinuxHandle, capture bool, maxCapture uint64) (string, []byte, uint64, *workspaceConfinedDomainError) {
	if file.kind != workspaceConfinedKindFile {
		return "", nil, 0, workspaceConfinedError("workspace_file_unsupported", "workspace path is not a regular file")
	}
	before, err := inspectWorkspaceConfinedLinuxFD(file.fd)
	if err != nil || before.kind != workspaceConfinedKindFile || before.dev != file.dev || before.ino != file.ino {
		return "", nil, 0, workspaceConfinedError("conflict_changed", "workspace file changed before reading")
	}
	if _, err := unix.Seek(file.fd, 0, 0); err != nil {
		return "", nil, 0, workspaceConfinedError("workspace_file_unsupported", "workspace file cannot be read")
	}
	hasher := sha1.New()
	var content []byte
	if capture {
		if before.stat.Size < 0 || uint64(before.stat.Size) > maxCapture {
			capture = false
		} else {
			content = make([]byte, 0, int(before.stat.Size))
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
	after, err := inspectWorkspaceConfinedLinuxFD(file.fd)
	if err != nil || after.kind != workspaceConfinedKindFile || !sameWorkspaceConfinedLinuxFileObservation(before.stat, after.stat) ||
		after.stat.Size < 0 || total != uint64(after.stat.Size) {
		return "", nil, 0, workspaceConfinedError("conflict_changed", "workspace file changed while reading")
	}
	return hex.EncodeToString(hasher.Sum(nil)), content, total, nil
}

func revalidateWorkspaceConfinedLinuxName(parent int, name string, expected workspaceConfinedLinuxHandle) error {
	var stat unix.Stat_t
	if err := unix.Fstatat(parent, name, &stat, unix.AT_SYMLINK_NOFOLLOW); err != nil {
		return err
	}
	kind, err := workspaceConfinedLinuxKind(stat.Mode)
	if err != nil {
		return err
	}
	if uint64(stat.Dev) != expected.dev || stat.Ino != expected.ino || kind != expected.kind {
		return fmt.Errorf("workspace path name no longer identifies the held object")
	}
	return nil
}

// Moves the held entry aside under a fresh name. RENAME_NOREPLACE makes the
// destination check atomic; the source name is revalidated against the held
// identity right before the rename.
func quarantineWorkspaceConfinedLinuxEntry(parent int, originalName string, expected workspaceConfinedLinuxHandle) (string, error) {
	for attempt := 0; attempt < 8; attempt++ {
		randomBytes := make([]byte, 16)
		if _, err := rand.Read(randomBytes); err != nil {
			return "", err
		}
		name := ".happier-conflict-quarantine-" + hex.EncodeToString(randomBytes)
		if err := revalidateWorkspaceConfinedLinuxName(parent, originalName, expected); err != nil {
			return "", err
		}
		err := unix.Renameat2(parent, originalName, parent, name, unix.RENAME_NOREPLACE)
		if errors.Is(err, unix.EEXIST) {
			continue
		}
		if err != nil {
			return "", err
		}
		return name, nil
	}
	return "", fmt.Errorf("could not create a unique quarantine name")
}

func deleteWorkspaceConfinedLinuxTree(parent int, name string, target workspaceConfinedLinuxHandle) error {
	if target.kind == workspaceConfinedKindDirectory {
		names, err := listWorkspaceConfinedLinuxDirectory(target.fd)
		if err != nil {
			return err
		}
		for _, childName := range names {
			child, err := openWorkspaceConfinedLinuxAt(target.fd, childName)
			if err != nil {
				if errors.Is(err, unix.ENOENT) {
					continue
				}
				return err
			}
			deleteErr := deleteWorkspaceConfinedLinuxTree(target.fd, childName, child)
			closeErr := unix.Close(child.fd)
			if deleteErr != nil {
				return deleteErr
			}
			if closeErr != nil {
				return closeErr
			}
		}
	}
	current, err := inspectWorkspaceConfinedLinuxFD(target.fd)
	if err != nil || current.dev != target.dev || current.ino != target.ino || current.kind != target.kind {
		return fmt.Errorf("workspace entry changed before deletion")
	}
	if err := revalidateWorkspaceConfinedLinuxName(parent, name, target); err != nil {
		return err
	}
	flags := 0
	if target.kind == workspaceConfinedKindDirectory {
		flags = unix.AT_REMOVEDIR
	}
	return unix.Unlinkat(parent, name, flags)
}

func copyWorkspaceConfinedLinuxHandle(parent int, name string, entry workspaceConfinedLinuxHandle, destination string) error {
	switch entry.kind {
	case workspaceConfinedKindFile:
		duplicate, err := unix.Dup(entry.fd)
		if err != nil {
			return err
		}
		input := os.NewFile(uintptr(duplicate), "workspace-confined-source")
		if _, err := input.Seek(0, 0); err != nil {
			_ = input.Close()
			return err
		}
		output, err := os.OpenFile(destination, os.O_WRONLY|os.O_CREATE|os.O_EXCL, os.FileMode(entry.stat.Mode&0o777))
		if err != nil {
			_ = input.Close()
			return err
		}
		_, copyErr := output.ReadFrom(input)
		syncErr := output.Sync()
		closeOutErr := output.Close()
		closeInErr := input.Close()
		return errors.Join(copyErr, syncErr, closeOutErr, closeInErr)
	case workspaceConfinedKindSymlink:
		buffer := make([]byte, 4096)
		count, err := unix.Readlinkat(parent, name, buffer)
		if err != nil {
			return err
		}
		return os.Symlink(string(buffer[:count]), destination)
	case workspaceConfinedKindDirectory:
		if err := os.Mkdir(destination, os.FileMode(entry.stat.Mode&0o777)); err != nil {
			return err
		}
		names, err := listWorkspaceConfinedLinuxDirectory(entry.fd)
		if err != nil {
			return err
		}
		for _, childName := range names {
			child, err := openWorkspaceConfinedLinuxAt(entry.fd, childName)
			if err != nil {
				return err
			}
			copyErr := copyWorkspaceConfinedLinuxHandle(entry.fd, childName, child, filepath.Join(destination, childName))
			_ = unix.Close(child.fd)
			if copyErr != nil {
				return copyErr
			}
		}
		return nil
	default:
		return fmt.Errorf("unsupported entry")
	}
}

// The physical path of a held directory, for the recovery path in a result.
func workspaceConfinedLinuxPhysicalPath(fd int) (string, error) {
	path, err := os.Readlink("/proc/self/fd/" + strconv.Itoa(fd))
	if err != nil {
		return "", err
	}
	if !filepath.IsAbs(path) {
		return "", fmt.Errorf("held path is not absolute")
	}
	return path, nil
}
