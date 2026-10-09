//go:build darwin

package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"

	"golang.org/x/sys/unix"
)

type workspaceConfinedDarwinObserveOperation struct {
	path        *workspaceConfinedDarwinHeldPath
	measureSize bool
}
type workspaceConfinedDarwinCaptureOperation struct {
	path    *workspaceConfinedDarwinHeldPath
	request workspaceConfinedCaptureRequest
}
type workspaceConfinedDarwinApplyOperation struct {
	path    *workspaceConfinedDarwinHeldPath
	request workspaceConfinedApplyRequest
}
type workspaceConfinedDarwinRecoverOperation struct {
	root    workspaceConfinedDarwinHandle
	request workspaceConfinedRecoverRequest
}

func prepareWorkspaceConfinedObserve(request workspaceConfinedObserveRequest) (workspaceConfinedPreparedOperation, *workspaceConfinedDomainError) {
	held, err := openWorkspaceConfinedDarwinHeldPath(request.rootPath, request.relativePath)
	if err != nil {
		return nil, err
	}
	return &workspaceConfinedDarwinObserveOperation{path: held, measureSize: request.measureSize}, nil
}

func prepareWorkspaceConfinedCapture(request workspaceConfinedCaptureRequest) (workspaceConfinedPreparedOperation, *workspaceConfinedDomainError) {
	held, err := openWorkspaceConfinedDarwinHeldPath(request.rootPath, request.relativePath)
	if err != nil {
		return nil, err
	}
	if _, err := workspaceConfinedValidatePrivateDirectory(request.captureDirectory); err != nil {
		held.close()
		return nil, err
	}
	return &workspaceConfinedDarwinCaptureOperation{path: held, request: request}, nil
}

func prepareWorkspaceConfinedApply(request workspaceConfinedApplyRequest) (workspaceConfinedPreparedOperation, *workspaceConfinedDomainError) {
	held, err := openWorkspaceConfinedDarwinHeldPath(request.rootPath, request.relativePath)
	if err != nil {
		return nil, err
	}
	if held.missingIndex >= 0 && held.missingIndex != len(held.components)-1 {
		held.close()
		return nil, workspaceConfinedError("workspace_root_unsafe", "workspace destination parent is missing")
	}
	if _, err := workspaceConfinedValidatePrivateDirectory(request.recoveryDirectory); err != nil {
		held.close()
		return nil, err
	}
	return &workspaceConfinedDarwinApplyOperation{path: held, request: request}, nil
}

func prepareWorkspaceConfinedRecover(request workspaceConfinedRecoverRequest) (workspaceConfinedPreparedOperation, *workspaceConfinedDomainError) {
	_, root, err := openWorkspaceConfinedDarwinRoot(request.rootPath)
	if err != nil {
		return nil, workspaceConfinedError("workspace_root_unsafe", "workspace root could not be opened safely")
	}
	if _, domainErr := workspaceConfinedValidatePrivateDirectory(request.recoveryDirectory); domainErr != nil {
		_ = unix.Close(root.fd)
		return nil, domainErr
	}
	return &workspaceConfinedDarwinRecoverOperation{root: root, request: request}, nil
}

func (o *workspaceConfinedDarwinObserveOperation) close() { o.path.close() }
func (o *workspaceConfinedDarwinCaptureOperation) close() { o.path.close() }
func (o *workspaceConfinedDarwinApplyOperation) close()   { o.path.close() }
func (o *workspaceConfinedDarwinRecoverOperation) close() { _ = unix.Close(o.root.fd) }

func (o *workspaceConfinedDarwinObserveOperation) commit() workspaceConfinedResult {
	if err := o.path.revalidate(); err != nil {
		return err.result()
	}
	var sizeBytes uint64
	var measurement *uint64
	if o.measureSize {
		measurement = &sizeBytes
	}
	expectation, err := observeWorkspaceConfinedDarwinHeldPathMode(o.path, measurement)
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

func (o *workspaceConfinedDarwinCaptureOperation) commit() workspaceConfinedResult {
	if err := o.path.revalidate(); err != nil {
		return err.result()
	}
	observed, err := observeWorkspaceConfinedDarwinHeldPath(o.path)
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
	parent, name, target := darwinHeldParentNameTarget(o.path)
	if target == nil {
		return workspaceConfinedError("conflict_changed", "workspace source disappeared before capture").result()
	}
	if err := copyWorkspaceConfinedDarwinHandle(parent.fd, name, *target, materialPath); err != nil {
		_ = removeWorkspaceConfinedPrivateMaterial(materialPath)
		return workspaceConfinedError("workspace_file_unsupported", "workspace entry could not be captured completely").result()
	}
	materialExpectation, materialErr := observeWorkspaceConfinedPrivateMaterial(materialPath)
	current, currentErr := observeWorkspaceConfinedDarwinHeldPath(o.path)
	if materialErr != nil || currentErr != nil || !workspaceConfinedExpectationsEqual(materialExpectation, observed) || !workspaceConfinedExpectationsEqual(current, observed) {
		_ = removeWorkspaceConfinedPrivateMaterial(materialPath)
		return workspaceConfinedError("conflict_changed", "workspace source changed during capture").result()
	}
	return workspaceConfinedCapturedResult(observed, &materialPath)
}

func (o *workspaceConfinedDarwinApplyOperation) commit() workspaceConfinedResult {
	if err := o.path.revalidate(); err != nil {
		return err.result()
	}
	current, err := observeWorkspaceConfinedDarwinHeldPath(o.path)
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
	parent, finalName, existing := darwinHeldParentNameTarget(o.path)
	parentPath, pathErr := workspaceConfinedDarwinPhysicalPath(parent.fd)
	if pathErr != nil {
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
	record := workspaceConfinedRecoveryRecord{V: 1, OperationID: o.request.operationID, RootPath: o.path.rootPath,
		RootIdentity: darwinWorkspaceConfinedIdentity(o.path.handles[0]), RelativePath: o.request.relativePath,
		ExpectedDestination: o.request.expectedDestination, SelectedExpectation: o.request.selectedExpectation,
		CandidateName: candidateName, PriorName: priorName}
	if err := workspaceConfinedWriteRecoveryRecord(recordPath, record); err != nil {
		return workspaceConfinedError("conflict_resolution_unsupported", "workspace recovery evidence could not be retained").result()
	}
	if o.request.materialPath != nil {
		if err := copyWorkspaceConfinedPrivateMaterial(*o.request.materialPath, candidatePath); err != nil {
			return workspaceConfinedRecoveryNeeded(candidatePath)
		}
		candidate, openErr := openWorkspaceConfinedDarwinComponent(parent.fd, candidateName)
		if openErr != nil {
			return workspaceConfinedRecoveryNeeded(candidatePath)
		}
		candidateObserved, observeErr := observeWorkspaceConfinedDarwinEntry(parent.fd, candidateName, candidate)
		_ = unix.Close(candidate.fd)
		if observeErr != nil || !workspaceConfinedExpectationsEqual(candidateObserved, o.request.selectedExpectation) {
			return workspaceConfinedRecoveryNeeded(candidatePath)
		}
	}
	if existing != nil {
		if err := revalidateWorkspaceConfinedDarwinName(parent.fd, finalName, *existing); err != nil || unix.RenameatxNp(parent.fd, finalName, parent.fd, priorName, unix.RENAME_EXCL) != nil {
			return workspaceConfinedRecoveryNeeded(recordPath)
		}
	}
	if o.request.selectedExpectation.Kind != workspaceConfinedKindMissing {
		if err := unix.RenameatxNp(parent.fd, candidateName, parent.fd, finalName, unix.RENAME_EXCL); err != nil {
			if restored := restoreWorkspaceConfinedDarwinPrior(parent.fd, finalName, priorName, existing != nil); restored {
				if !workspaceConfinedDisplacedMatchesOrWasCleaned(candidatePath, o.request.selectedExpectation) || removeWorkspaceConfinedDarwinNamedEntry(parent.fd, candidateName) != nil {
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
	public, publicErr := openWorkspaceConfinedDarwinComponent(parent.fd, finalName)
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
		installed, observeErr := observeWorkspaceConfinedDarwinEntry(parent.fd, finalName, public)
		_ = unix.Close(public.fd)
		if observeErr != nil || !workspaceConfinedExpectationsEqual(installed, o.request.selectedExpectation) {
			return workspaceConfinedRecoveryNeeded(priorPath)
		}
	}
	if existing != nil {
		if !workspaceConfinedDisplacedMatches(priorPath, o.request.expectedDestination) {
			return workspaceConfinedRecoveryNeeded(priorPath)
		}
		if err := removeWorkspaceConfinedDarwinNamedEntry(parent.fd, priorName); err != nil {
			return workspaceConfinedRecoveryNeeded(priorPath)
		}
	}
	if !workspaceConfinedDisplacedMatchesOrWasCleaned(candidatePath, o.request.selectedExpectation) || removeWorkspaceConfinedDarwinNamedEntry(parent.fd, candidateName) != nil {
		return workspaceConfinedRecoveryNeeded(candidatePath)
	}
	if err := os.Remove(recordPath); err != nil {
		return workspaceConfinedRecoveryNeeded(recordPath)
	}
	return workspaceConfinedSuccess("installed")
}

func (o *workspaceConfinedDarwinRecoverOperation) commit() workspaceConfinedResult {
	recordPath := workspaceConfinedRecoveryRecordPath(o.request.recoveryDirectory, o.request.operationID)
	record, err := workspaceConfinedReadRecoveryRecord(recordPath)
	if errors.Is(err, os.ErrNotExist) {
		return workspaceConfinedSuccess("settled")
	}
	if err != nil || record.OperationID != o.request.operationID || filepath.Clean(record.RootPath) != filepath.Clean(o.request.rootPath) || record.RootIdentity != darwinWorkspaceConfinedIdentity(o.root) {
		return workspaceConfinedRecoveryNeeded(recordPath)
	}
	held, domainErr := openWorkspaceConfinedDarwinHeldPath(o.request.rootPath, record.RelativePath)
	if domainErr != nil {
		return workspaceConfinedRecoveryNeeded(recordPath)
	}
	defer held.close()
	if held.missingIndex >= 0 && held.missingIndex != len(held.components)-1 {
		return workspaceConfinedRecoveryNeeded(recordPath)
	}
	parent, finalName, _ := darwinHeldParentNameTarget(held)
	public, observeErr := observeWorkspaceConfinedDarwinHeldPath(held)
	if observeErr != nil {
		return workspaceConfinedRecoveryNeeded(recordPath)
	}
	parentPath, pathErr := workspaceConfinedDarwinPhysicalPath(parent.fd)
	if pathErr != nil {
		return workspaceConfinedRecoveryNeeded(recordPath)
	}
	priorPath := filepath.Join(parentPath, record.PriorName)
	candidatePath := filepath.Join(parentPath, record.CandidateName)
	if workspaceConfinedExpectationsEqual(public, record.SelectedExpectation) {
		if !workspaceConfinedDisplacedMatchesOrWasCleaned(priorPath, record.ExpectedDestination) {
			return workspaceConfinedRecoveryNeeded(priorPath)
		}
		if !workspaceConfinedDisplacedMatchesOrWasCleaned(candidatePath, record.SelectedExpectation) || removeWorkspaceConfinedDarwinNamedEntry(parent.fd, record.CandidateName) != nil {
			return workspaceConfinedRecoveryNeeded(candidatePath)
		}
		if err := removeWorkspaceConfinedDarwinNamedEntry(parent.fd, record.PriorName); err != nil && !errors.Is(err, os.ErrNotExist) {
			return workspaceConfinedRecoveryNeeded(priorPath)
		}
		if err := os.Remove(recordPath); err != nil {
			return workspaceConfinedRecoveryNeeded(recordPath)
		}
		return workspaceConfinedSuccess("settled")
	}
	if workspaceConfinedExpectationsEqual(public, record.ExpectedDestination) {
		if !workspaceConfinedDisplacedMatchesOrWasCleaned(candidatePath, record.SelectedExpectation) || removeWorkspaceConfinedDarwinNamedEntry(parent.fd, record.CandidateName) != nil {
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
		if err := removeWorkspaceConfinedDarwinNamedEntry(parent.fd, record.PriorName); err != nil && !errors.Is(err, os.ErrNotExist) {
			return workspaceConfinedRecoveryNeeded(priorPath)
		}
		if !workspaceConfinedDisplacedMatchesOrWasCleaned(candidatePath, record.SelectedExpectation) || removeWorkspaceConfinedDarwinNamedEntry(parent.fd, record.CandidateName) != nil {
			return workspaceConfinedRecoveryNeeded(candidatePath)
		}
		if err := os.Remove(recordPath); err != nil {
			return workspaceConfinedRecoveryNeeded(recordPath)
		}
		return workspaceConfinedSuccess("settled")
	}
	if candidate, err := openWorkspaceConfinedDarwinComponent(parent.fd, record.CandidateName); err == nil {
		candidateExpectation, observeErr := observeWorkspaceConfinedDarwinEntry(parent.fd, record.CandidateName, candidate)
		_ = unix.Close(candidate.fd)
		if observeErr == nil && workspaceConfinedExpectationsEqual(candidateExpectation, record.SelectedExpectation) && workspaceConfinedDisplacedMatches(priorPath, record.ExpectedDestination) && unix.RenameatxNp(parent.fd, record.CandidateName, parent.fd, finalName, unix.RENAME_EXCL) == nil {
			if err := removeWorkspaceConfinedDarwinNamedEntry(parent.fd, record.PriorName); err != nil && !errors.Is(err, os.ErrNotExist) {
				return workspaceConfinedRecoveryNeeded(priorPath)
			}
			if err := os.Remove(recordPath); err != nil {
				return workspaceConfinedRecoveryNeeded(recordPath)
			}
			return workspaceConfinedSuccess("settled")
		}
	}
	if workspaceConfinedDisplacedMatches(priorPath, record.ExpectedDestination) && restoreWorkspaceConfinedDarwinPrior(parent.fd, finalName, record.PriorName, true) {
		if !workspaceConfinedDisplacedMatchesOrWasCleaned(candidatePath, record.SelectedExpectation) || removeWorkspaceConfinedDarwinNamedEntry(parent.fd, record.CandidateName) != nil {
			return workspaceConfinedRecoveryNeeded(candidatePath)
		}
		if err := os.Remove(recordPath); err != nil {
			return workspaceConfinedRecoveryNeeded(recordPath)
		}
		return workspaceConfinedSuccess("settled")
	}
	return workspaceConfinedRecoveryNeeded(priorPath)
}

func darwinHeldParentNameTarget(path *workspaceConfinedDarwinHeldPath) (workspaceConfinedDarwinHandle, string, *workspaceConfinedDarwinHandle) {
	name := path.components[len(path.components)-1]
	if path.missingIndex >= 0 {
		return path.handles[len(path.handles)-1], name, nil
	}
	parent := path.handles[len(path.handles)-2]
	target := path.handles[len(path.handles)-1]
	return parent, name, &target
}

func darwinWorkspaceConfinedIdentity(handle workspaceConfinedDarwinHandle) string {
	return strconv.FormatInt(int64(handle.identity.device), 10) + ":" + strconv.FormatUint(handle.identity.inode, 10)
}

func observeWorkspaceConfinedDarwinHeldPath(path *workspaceConfinedDarwinHeldPath) (workspaceConfinedExpectation, *workspaceConfinedDomainError) {
	return observeWorkspaceConfinedDarwinHeldPathMode(path, nil)
}

func observeWorkspaceConfinedDarwinHeldPathMode(path *workspaceConfinedDarwinHeldPath, measurement *uint64) (workspaceConfinedExpectation, *workspaceConfinedDomainError) {
	if path.missingIndex >= 0 {
		if measurement != nil {
			return workspaceConfinedExpectation{}, workspaceConfinedError("conflict_changed", "workspace entry disappeared during measurement")
		}
		return workspaceConfinedExpectation{Kind: workspaceConfinedKindMissing}, nil
	}
	parent, name, target := darwinHeldParentNameTarget(path)
	return observeWorkspaceConfinedDarwinEntryMode(parent.fd, name, *target, measurement)
}

func observeWorkspaceConfinedDarwinEntry(parent int, name string, entry workspaceConfinedDarwinHandle) (workspaceConfinedExpectation, *workspaceConfinedDomainError) {
	return observeWorkspaceConfinedDarwinEntryMode(parent, name, entry, nil)
}

// One traversal owns both complete effect expectations and passive metadata-only measurements.
func observeWorkspaceConfinedDarwinEntryMode(parent int, name string, entry workspaceConfinedDarwinHandle, measurement *uint64) (workspaceConfinedExpectation, *workspaceConfinedDomainError) {
	current, err := inspectWorkspaceConfinedDarwinFD(entry.fd)
	if err != nil || !sameWorkspaceConfinedDarwinObject(current, entry) {
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
		digest, _, size, readErr := readWorkspaceConfinedDarwinFile(entry, false, 0)
		if readErr != nil {
			return workspaceConfinedExpectation{}, readErr
		}
		executable := current.stat.Mode&0o111 != 0
		return workspaceConfinedExpectation{Kind: entry.kind, Digest: digest, Executable: &executable, Size: &size}, nil
	case workspaceConfinedKindSymlink:
		if measurement != nil {
			return workspaceConfinedExpectation{}, nil
		}
		buffer := make([]byte, 4096)
		count, err := unix.Readlinkat(parent, name, buffer)
		if err != nil || count < 0 || count > len(buffer) {
			return workspaceConfinedExpectation{}, workspaceConfinedError("workspace_file_unsupported", "workspace symlink target could not be read")
		}
		if !utf8.Valid(buffer[:count]) {
			return workspaceConfinedExpectation{}, workspaceConfinedError("workspace_file_unsupported", "workspace symlink target cannot be represented")
		}
		if err := revalidateWorkspaceConfinedDarwinName(parent, name, entry); err != nil {
			return workspaceConfinedExpectation{}, workspaceConfinedError("conflict_changed", "workspace symlink changed during observation")
		}
		return workspaceConfinedExpectation{Kind: entry.kind, Target: string(buffer[:count])}, nil
	case workspaceConfinedKindDirectory:
		before := current.stat
		names, err := listWorkspaceConfinedDarwinDirectory(entry.fd)
		if err != nil {
			return workspaceConfinedExpectation{}, workspaceConfinedError("workspace_file_unsupported", "workspace directory could not be observed completely")
		}
		fingerprint := newWorkspaceConfinedFingerprintWriter()
		for _, childName := range names {
			child, err := openWorkspaceConfinedDarwinComponent(entry.fd, childName)
			if err != nil {
				return workspaceConfinedExpectation{}, workspaceConfinedError("conflict_changed", "workspace directory changed during observation")
			}
			childExpectation, childErr := observeWorkspaceConfinedDarwinEntryMode(entry.fd, childName, child, measurement)
			_ = unix.Close(child.fd)
			if childErr != nil {
				return workspaceConfinedExpectation{}, childErr
			}
			if measurement == nil {
				fingerprint.add(childName, childExpectation)
			}
		}
		after, err := inspectWorkspaceConfinedDarwinFD(entry.fd)
		if err != nil || !sameWorkspaceConfinedDarwinFileObservation(before, after.stat) {
			return workspaceConfinedExpectation{}, workspaceConfinedError("conflict_changed", "workspace directory changed during observation")
		}
		if measurement != nil {
			return workspaceConfinedExpectation{}, nil
		}
		return workspaceConfinedExpectation{Kind: entry.kind, Fingerprint: fingerprint.finish()}, nil
	default:
		return workspaceConfinedExpectation{}, workspaceConfinedError("workspace_file_unsupported", "workspace entry type is unsupported")
	}
}

func listWorkspaceConfinedDarwinDirectory(fd int) ([]string, error) {
	duplicate, err := unix.Dup(fd)
	if err != nil {
		return nil, err
	}
	unix.CloseOnExec(duplicate)
	directory := os.NewFile(uintptr(duplicate), "workspace-confined-directory")
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
		if name == "" || name == "." || name == ".." || strings.Contains(name, "/") || strings.IndexByte(name, 0) >= 0 || !utf8.ValidString(name) {
			return nil, fmt.Errorf("unsafe directory entry name")
		}
		names = append(names, name)
	}
	sort.Strings(names)
	return names, nil
}

func copyWorkspaceConfinedDarwinHandle(parent int, name string, entry workspaceConfinedDarwinHandle, destination string) error {
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
		if copyErr != nil {
			return copyErr
		}
		if syncErr != nil {
			return syncErr
		}
		if closeOutErr != nil {
			return closeOutErr
		}
		return closeInErr
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
		names, err := listWorkspaceConfinedDarwinDirectory(entry.fd)
		if err != nil {
			return err
		}
		for _, childName := range names {
			child, err := openWorkspaceConfinedDarwinComponent(entry.fd, childName)
			if err != nil {
				return err
			}
			copyErr := copyWorkspaceConfinedDarwinHandle(entry.fd, childName, child, filepath.Join(destination, childName))
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

func removeWorkspaceConfinedDarwinNamedEntry(parent int, name string) error {
	entry, err := openWorkspaceConfinedDarwinComponent(parent, name)
	if errors.Is(err, unix.ENOENT) {
		return nil
	}
	if err != nil {
		return err
	}
	deleteErr := deleteWorkspaceConfinedDarwinTree(parent, name, entry)
	closeErr := unix.Close(entry.fd)
	if deleteErr != nil {
		return deleteErr
	}
	return closeErr
}

func restoreWorkspaceConfinedDarwinPrior(parent int, finalName, priorName string, hasPrior bool) bool {
	if !hasPrior {
		return true
	}
	return unix.RenameatxNp(parent, priorName, parent, finalName, unix.RENAME_EXCL) == nil
}
