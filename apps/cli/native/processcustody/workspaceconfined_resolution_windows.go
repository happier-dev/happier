//go:build windows

package main

import (
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"

	"golang.org/x/sys/windows"
)

type workspaceConfinedWindowsObserveOperation struct {
	path        *workspaceConfinedHeldPath
	measureSize bool
}
type workspaceConfinedWindowsCaptureOperation struct {
	path    *workspaceConfinedHeldPath
	request workspaceConfinedCaptureRequest
}
type workspaceConfinedWindowsApplyOperation struct {
	path    *workspaceConfinedHeldPath
	request workspaceConfinedApplyRequest
}
type workspaceConfinedWindowsRecoverOperation struct {
	root    workspaceConfinedHandle
	request workspaceConfinedRecoverRequest
}

func prepareWorkspaceConfinedObserve(request workspaceConfinedObserveRequest) (workspaceConfinedPreparedOperation, *workspaceConfinedDomainError) {
	held, err := openWorkspaceConfinedHeldPath(request.rootPath, request.relativePath, false)
	if err != nil {
		return nil, err
	}
	return &workspaceConfinedWindowsObserveOperation{path: held, measureSize: request.measureSize}, nil
}
func prepareWorkspaceConfinedCapture(request workspaceConfinedCaptureRequest) (workspaceConfinedPreparedOperation, *workspaceConfinedDomainError) {
	held, err := openWorkspaceConfinedHeldPath(request.rootPath, request.relativePath, false)
	if err != nil {
		return nil, err
	}
	if _, domainErr := workspaceConfinedValidatePrivateDirectory(request.captureDirectory); domainErr != nil {
		held.close()
		return nil, domainErr
	}
	return &workspaceConfinedWindowsCaptureOperation{path: held, request: request}, nil
}
func prepareWorkspaceConfinedApply(request workspaceConfinedApplyRequest) (workspaceConfinedPreparedOperation, *workspaceConfinedDomainError) {
	held, err := openWorkspaceConfinedHeldPath(request.rootPath, request.relativePath, true)
	if err != nil {
		return nil, err
	}
	if held.missingIndex >= 0 && held.missingIndex != len(held.components)-1 {
		held.close()
		return nil, workspaceConfinedError("workspace_root_unsafe", "workspace destination parent is missing")
	}
	if _, domainErr := workspaceConfinedValidatePrivateDirectory(request.recoveryDirectory); domainErr != nil {
		held.close()
		return nil, domainErr
	}
	return &workspaceConfinedWindowsApplyOperation{path: held, request: request}, nil
}
func prepareWorkspaceConfinedRecover(request workspaceConfinedRecoverRequest) (workspaceConfinedPreparedOperation, *workspaceConfinedDomainError) {
	_, ntRoot, domainErr := workspaceConfinedNTAbsolutePath(request.rootPath)
	if domainErr != nil {
		return nil, domainErr
	}
	root, err := openWorkspaceConfinedAbsoluteRoot(ntRoot)
	if err != nil {
		return nil, workspaceConfinedError("workspace_root_unsafe", "workspace root could not be opened safely")
	}
	if _, domainErr := workspaceConfinedValidatePrivateDirectory(request.recoveryDirectory); domainErr != nil {
		_ = windows.CloseHandle(root.handle)
		return nil, domainErr
	}
	return &workspaceConfinedWindowsRecoverOperation{root: root, request: request}, nil
}

func (o *workspaceConfinedWindowsObserveOperation) close() { o.path.close() }
func (o *workspaceConfinedWindowsCaptureOperation) close() { o.path.close() }
func (o *workspaceConfinedWindowsApplyOperation) close()   { o.path.close() }
func (o *workspaceConfinedWindowsRecoverOperation) close() { _ = windows.CloseHandle(o.root.handle) }

func (o *workspaceConfinedWindowsObserveOperation) commit() workspaceConfinedResult {
	if err := o.path.revalidate(); err != nil {
		return err.result()
	}
	var sizeBytes uint64
	var measurement *uint64
	if o.measureSize {
		measurement = &sizeBytes
	}
	expectation, err := observeWorkspaceConfinedWindowsHeldPathMode(o.path, measurement)
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
func (o *workspaceConfinedWindowsCaptureOperation) commit() workspaceConfinedResult {
	if err := o.path.revalidate(); err != nil {
		return err.result()
	}
	observed, err := observeWorkspaceConfinedWindowsHeldPath(o.path)
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
	parent, _, target := windowsHeldParentNameTarget(o.path)
	if target == nil {
		return workspaceConfinedError("conflict_changed", "workspace source disappeared before capture").result()
	}
	if err := copyWorkspaceConfinedWindowsHandle(*target, materialPath); err != nil {
		_ = removeWorkspaceConfinedPrivateMaterial(materialPath)
		return workspaceConfinedError("workspace_file_unsupported", "workspace entry could not be captured completely").result()
	}
	materialExpectation, materialErr := observeWorkspaceConfinedPrivateMaterial(materialPath)
	current, currentErr := observeWorkspaceConfinedWindowsHeldPath(o.path)
	if materialErr != nil || currentErr != nil || !workspaceConfinedExpectationsEqual(materialExpectation, observed) || !workspaceConfinedExpectationsEqual(current, observed) {
		_ = removeWorkspaceConfinedPrivateMaterial(materialPath)
		return workspaceConfinedError("conflict_changed", "workspace source changed during capture").result()
	}
	_ = parent
	return workspaceConfinedCapturedResult(observed, &materialPath)
}
func (o *workspaceConfinedWindowsApplyOperation) commit() workspaceConfinedResult {
	if err := o.path.revalidate(); err != nil {
		return err.result()
	}
	current, err := observeWorkspaceConfinedWindowsHeldPath(o.path)
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
	parent, finalName, existing := windowsHeldParentNameTarget(o.path)
	parentPath, pathErr := workspaceConfinedPhysicalPath(parent.handle)
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
		RootIdentity: windowsWorkspaceConfinedIdentity(o.path.handles[0]), RelativePath: o.request.relativePath,
		ExpectedDestination: o.request.expectedDestination, SelectedExpectation: o.request.selectedExpectation,
		CandidateName: candidateName, PriorName: priorName}
	if err := workspaceConfinedWriteRecoveryRecord(recordPath, record); err != nil {
		return workspaceConfinedError("conflict_resolution_unsupported", "workspace recovery evidence could not be retained").result()
	}
	if o.request.materialPath != nil {
		if err := copyWorkspaceConfinedPrivateMaterial(*o.request.materialPath, candidatePath); err != nil {
			return workspaceConfinedRecoveryNeeded(candidatePath)
		}
		candidate, openErr := openWorkspaceConfinedRelative(parent.handle, candidateName, true)
		if openErr != nil {
			return workspaceConfinedRecoveryNeeded(candidatePath)
		}
		candidateObserved, observeErr := observeWorkspaceConfinedWindowsEntry(candidate)
		_ = windows.CloseHandle(candidate.handle)
		if observeErr != nil || !workspaceConfinedExpectationsEqual(candidateObserved, o.request.selectedExpectation) {
			return workspaceConfinedRecoveryNeeded(candidatePath)
		}
	}
	if existing != nil {
		if err := renameWorkspaceConfinedHandle(existing.handle, parent.handle, priorName); err != nil {
			return workspaceConfinedRecoveryNeeded(recordPath)
		}
	}
	if o.request.selectedExpectation.Kind != workspaceConfinedKindMissing {
		candidate, openErr := openWorkspaceConfinedRelative(parent.handle, candidateName, true)
		if openErr != nil || renameWorkspaceConfinedHandle(candidate.handle, parent.handle, finalName) != nil {
			if openErr == nil {
				_ = windows.CloseHandle(candidate.handle)
			}
			if restoreWorkspaceConfinedWindowsPrior(parent.handle, finalName, priorName, existing != nil) {
				if !workspaceConfinedDisplacedMatchesOrWasCleaned(candidatePath, o.request.selectedExpectation) || removeWorkspaceConfinedWindowsNamedEntry(parent.handle, candidateName) != nil {
					return workspaceConfinedRecoveryNeeded(candidatePath)
				}
				if err := os.Remove(recordPath); err != nil {
					return workspaceConfinedRecoveryNeeded(recordPath)
				}
				return workspaceConfinedSuccess("restored")
			}
			return workspaceConfinedRecoveryNeeded(priorPath)
		}
		_ = windows.CloseHandle(candidate.handle)
	}
	public, publicErr := openWorkspaceConfinedRelative(parent.handle, finalName, false)
	if o.request.selectedExpectation.Kind == workspaceConfinedKindMissing {
		if publicErr == nil {
			_ = windows.CloseHandle(public.handle)
			return workspaceConfinedRecoveryNeeded(priorPath)
		}
		if !workspaceConfinedIsNotFound(publicErr) {
			return workspaceConfinedRecoveryNeeded(priorPath)
		}
	} else {
		if publicErr != nil {
			return workspaceConfinedRecoveryNeeded(priorPath)
		}
		installed, observeErr := observeWorkspaceConfinedWindowsEntry(public)
		_ = windows.CloseHandle(public.handle)
		if observeErr != nil || !workspaceConfinedExpectationsEqual(installed, o.request.selectedExpectation) {
			return workspaceConfinedRecoveryNeeded(priorPath)
		}
	}
	if existing != nil {
		if !workspaceConfinedDisplacedMatches(priorPath, o.request.expectedDestination) {
			return workspaceConfinedRecoveryNeeded(priorPath)
		}
		if err := removeWorkspaceConfinedWindowsNamedEntry(parent.handle, priorName); err != nil {
			return workspaceConfinedRecoveryNeeded(priorPath)
		}
	}
	if !workspaceConfinedDisplacedMatchesOrWasCleaned(candidatePath, o.request.selectedExpectation) || removeWorkspaceConfinedWindowsNamedEntry(parent.handle, candidateName) != nil {
		return workspaceConfinedRecoveryNeeded(candidatePath)
	}
	if err := os.Remove(recordPath); err != nil {
		return workspaceConfinedRecoveryNeeded(recordPath)
	}
	return workspaceConfinedSuccess("installed")
}

func (o *workspaceConfinedWindowsRecoverOperation) commit() workspaceConfinedResult {
	recordPath := workspaceConfinedRecoveryRecordPath(o.request.recoveryDirectory, o.request.operationID)
	record, err := workspaceConfinedReadRecoveryRecord(recordPath)
	if errors.Is(err, os.ErrNotExist) {
		return workspaceConfinedSuccess("settled")
	}
	if err != nil || record.OperationID != o.request.operationID || filepath.Clean(record.RootPath) != filepath.Clean(o.request.rootPath) || record.RootIdentity != windowsWorkspaceConfinedIdentity(o.root) {
		return workspaceConfinedRecoveryNeeded(recordPath)
	}
	held, domainErr := openWorkspaceConfinedHeldPath(o.request.rootPath, record.RelativePath, true)
	if domainErr != nil {
		return workspaceConfinedRecoveryNeeded(recordPath)
	}
	defer held.close()
	if held.missingIndex >= 0 && held.missingIndex != len(held.components)-1 {
		return workspaceConfinedRecoveryNeeded(recordPath)
	}
	parent, finalName, _ := windowsHeldParentNameTarget(held)
	public, observeErr := observeWorkspaceConfinedWindowsHeldPath(held)
	if observeErr != nil {
		return workspaceConfinedRecoveryNeeded(recordPath)
	}
	parentPath, pathErr := workspaceConfinedPhysicalPath(parent.handle)
	if pathErr != nil {
		return workspaceConfinedRecoveryNeeded(recordPath)
	}
	priorPath := filepath.Join(parentPath, record.PriorName)
	candidatePath := filepath.Join(parentPath, record.CandidateName)
	if workspaceConfinedExpectationsEqual(public, record.SelectedExpectation) {
		if !workspaceConfinedDisplacedMatchesOrWasCleaned(priorPath, record.ExpectedDestination) {
			return workspaceConfinedRecoveryNeeded(priorPath)
		}
		if !workspaceConfinedDisplacedMatchesOrWasCleaned(candidatePath, record.SelectedExpectation) || removeWorkspaceConfinedWindowsNamedEntry(parent.handle, record.CandidateName) != nil {
			return workspaceConfinedRecoveryNeeded(candidatePath)
		}
		if err := removeWorkspaceConfinedWindowsNamedEntry(parent.handle, record.PriorName); err != nil && !errors.Is(err, os.ErrNotExist) {
			return workspaceConfinedRecoveryNeeded(priorPath)
		}
		if err := os.Remove(recordPath); err != nil {
			return workspaceConfinedRecoveryNeeded(recordPath)
		}
		return workspaceConfinedSuccess("settled")
	}
	if workspaceConfinedExpectationsEqual(public, record.ExpectedDestination) {
		if !workspaceConfinedDisplacedMatchesOrWasCleaned(candidatePath, record.SelectedExpectation) || removeWorkspaceConfinedWindowsNamedEntry(parent.handle, record.CandidateName) != nil {
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
		if err := removeWorkspaceConfinedWindowsNamedEntry(parent.handle, record.PriorName); err != nil && !errors.Is(err, os.ErrNotExist) {
			return workspaceConfinedRecoveryNeeded(priorPath)
		}
		if !workspaceConfinedDisplacedMatchesOrWasCleaned(candidatePath, record.SelectedExpectation) || removeWorkspaceConfinedWindowsNamedEntry(parent.handle, record.CandidateName) != nil {
			return workspaceConfinedRecoveryNeeded(candidatePath)
		}
		if err := os.Remove(recordPath); err != nil {
			return workspaceConfinedRecoveryNeeded(recordPath)
		}
		return workspaceConfinedSuccess("settled")
	}
	if candidate, err := openWorkspaceConfinedRelative(parent.handle, record.CandidateName, true); err == nil {
		candidateExpectation, observeErr := observeWorkspaceConfinedWindowsEntry(candidate)
		if observeErr == nil && workspaceConfinedExpectationsEqual(candidateExpectation, record.SelectedExpectation) && workspaceConfinedDisplacedMatches(priorPath, record.ExpectedDestination) && renameWorkspaceConfinedHandle(candidate.handle, parent.handle, finalName) == nil {
			_ = windows.CloseHandle(candidate.handle)
			if err := removeWorkspaceConfinedWindowsNamedEntry(parent.handle, record.PriorName); err != nil && !errors.Is(err, os.ErrNotExist) {
				return workspaceConfinedRecoveryNeeded(priorPath)
			}
			if err := os.Remove(recordPath); err != nil {
				return workspaceConfinedRecoveryNeeded(recordPath)
			}
			return workspaceConfinedSuccess("settled")
		}
		_ = windows.CloseHandle(candidate.handle)
	}
	if workspaceConfinedDisplacedMatches(priorPath, record.ExpectedDestination) && restoreWorkspaceConfinedWindowsPrior(parent.handle, finalName, record.PriorName, true) {
		if !workspaceConfinedDisplacedMatchesOrWasCleaned(candidatePath, record.SelectedExpectation) || removeWorkspaceConfinedWindowsNamedEntry(parent.handle, record.CandidateName) != nil {
			return workspaceConfinedRecoveryNeeded(candidatePath)
		}
		if err := os.Remove(recordPath); err != nil {
			return workspaceConfinedRecoveryNeeded(recordPath)
		}
		return workspaceConfinedSuccess("settled")
	}
	return workspaceConfinedRecoveryNeeded(priorPath)
}

func windowsHeldParentNameTarget(path *workspaceConfinedHeldPath) (workspaceConfinedHandle, string, *workspaceConfinedHandle) {
	name := path.components[len(path.components)-1]
	if path.missingIndex >= 0 {
		return path.handles[len(path.handles)-1], name, nil
	}
	parent := path.handles[len(path.handles)-2]
	target := path.handles[len(path.handles)-1]
	return parent, name, &target
}
func windowsWorkspaceConfinedIdentity(handle workspaceConfinedHandle) string {
	return strconv.FormatUint(handle.identity.volumeSerial, 10) + ":" + hex.EncodeToString(handle.identity.fileID[:])
}
func observeWorkspaceConfinedWindowsHeldPath(path *workspaceConfinedHeldPath) (workspaceConfinedExpectation, *workspaceConfinedDomainError) {
	return observeWorkspaceConfinedWindowsHeldPathMode(path, nil)
}

func observeWorkspaceConfinedWindowsHeldPathMode(path *workspaceConfinedHeldPath, measurement *uint64) (workspaceConfinedExpectation, *workspaceConfinedDomainError) {
	if path.missingIndex >= 0 {
		if measurement != nil {
			return workspaceConfinedExpectation{}, workspaceConfinedError("conflict_changed", "workspace entry disappeared during measurement")
		}
		return workspaceConfinedExpectation{Kind: workspaceConfinedKindMissing}, nil
	}
	return observeWorkspaceConfinedWindowsEntryMode(path.final(), measurement)
}
func observeWorkspaceConfinedWindowsEntry(entry workspaceConfinedHandle) (workspaceConfinedExpectation, *workspaceConfinedDomainError) {
	return observeWorkspaceConfinedWindowsEntryMode(entry, nil)
}

// One traversal owns both complete effect expectations and passive metadata-only measurements.
func observeWorkspaceConfinedWindowsEntryMode(entry workspaceConfinedHandle, measurement *uint64) (workspaceConfinedExpectation, *workspaceConfinedDomainError) {
	current, err := inspectWorkspaceConfinedHandle(entry.handle)
	if err != nil || current.identity != entry.identity || current.kind != entry.kind {
		return workspaceConfinedExpectation{}, workspaceConfinedError("conflict_changed", "workspace entry changed during observation")
	}
	switch entry.kind {
	case workspaceConfinedKindFile:
		if measurement != nil {
			return workspaceConfinedExpectation{}, addWorkspaceConfinedMeasuredBytes(measurement, workspaceConfinedFileSize(current.info))
		}
		digest, _, size, readErr := readWorkspaceConfinedFile(entry, false, 0)
		if readErr != nil {
			return workspaceConfinedExpectation{}, readErr
		}
		executable := false
		return workspaceConfinedExpectation{Kind: entry.kind, Digest: digest, Executable: &executable, Size: &size}, nil
	case workspaceConfinedKindSymlink:
		if measurement != nil {
			return workspaceConfinedExpectation{}, nil
		}
		path, err := workspaceConfinedPhysicalPath(entry.handle)
		if err != nil {
			return workspaceConfinedExpectation{}, workspaceConfinedError("workspace_file_unsupported", "workspace reparse target could not be resolved")
		}
		target, err := os.Readlink(path)
		if err != nil {
			return workspaceConfinedExpectation{}, workspaceConfinedError("workspace_file_unsupported", "workspace reparse target could not be read")
		}
		after, err := inspectWorkspaceConfinedHandle(entry.handle)
		if err != nil || after.identity != entry.identity {
			return workspaceConfinedExpectation{}, workspaceConfinedError("conflict_changed", "workspace reparse point changed during observation")
		}
		return workspaceConfinedExpectation{Kind: entry.kind, Target: target}, nil
	case workspaceConfinedKindDirectory:
		before := current.info
		names, err := listWorkspaceConfinedDirectory(entry.handle)
		if err != nil {
			return workspaceConfinedExpectation{}, workspaceConfinedError("workspace_file_unsupported", "workspace directory could not be observed completely")
		}
		sort.Strings(names)
		fingerprint := newWorkspaceConfinedFingerprintWriter()
		for _, name := range names {
			child, err := openWorkspaceConfinedRelative(entry.handle, name, false)
			if err != nil {
				return workspaceConfinedExpectation{}, workspaceConfinedError("conflict_changed", "workspace directory changed during observation")
			}
			childExpectation, childErr := observeWorkspaceConfinedWindowsEntryMode(child, measurement)
			_ = windows.CloseHandle(child.handle)
			if childErr != nil {
				return workspaceConfinedExpectation{}, childErr
			}
			if measurement == nil {
				fingerprint.add(name, childExpectation)
			}
		}
		after, err := inspectWorkspaceConfinedHandle(entry.handle)
		if err != nil || !workspaceConfinedSameFileObservation(before, after.info) {
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
func copyWorkspaceConfinedWindowsHandle(entry workspaceConfinedHandle, destination string) error {
	switch entry.kind {
	case workspaceConfinedKindFile:
		process := windows.CurrentProcess()
		var duplicate windows.Handle
		if err := windows.DuplicateHandle(process, entry.handle, process, &duplicate, 0, false, windows.DUPLICATE_SAME_ACCESS); err != nil {
			return err
		}
		input := os.NewFile(uintptr(duplicate), "workspace-confined-source")
		if _, err := input.Seek(0, 0); err != nil {
			_ = input.Close()
			return err
		}
		output, err := os.OpenFile(destination, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
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
		path, err := workspaceConfinedPhysicalPath(entry.handle)
		if err != nil {
			return err
		}
		target, err := os.Readlink(path)
		if err != nil {
			return err
		}
		return os.Symlink(target, destination)
	case workspaceConfinedKindDirectory:
		if err := os.Mkdir(destination, 0o700); err != nil {
			return err
		}
		names, err := listWorkspaceConfinedDirectory(entry.handle)
		if err != nil {
			return err
		}
		for _, name := range names {
			child, err := openWorkspaceConfinedRelative(entry.handle, name, false)
			if err != nil {
				return err
			}
			copyErr := copyWorkspaceConfinedWindowsHandle(child, filepath.Join(destination, name))
			_ = windows.CloseHandle(child.handle)
			if copyErr != nil {
				return copyErr
			}
		}
		return nil
	default:
		return fmt.Errorf("unsupported entry")
	}
}
func removeWorkspaceConfinedWindowsNamedEntry(parent windows.Handle, name string) error {
	entry, err := openWorkspaceConfinedRelative(parent, name, true)
	if workspaceConfinedIsNotFound(err) {
		return nil
	}
	if err != nil {
		return err
	}
	deleteErr := deleteWorkspaceConfinedTree(entry)
	closeErr := windows.CloseHandle(entry.handle)
	if deleteErr != nil {
		return deleteErr
	}
	return closeErr
}
func restoreWorkspaceConfinedWindowsPrior(parent windows.Handle, finalName, priorName string, hasPrior bool) bool {
	if !hasPrior {
		return true
	}
	prior, err := openWorkspaceConfinedRelative(parent, priorName, true)
	if err != nil {
		return false
	}
	defer windows.CloseHandle(prior.handle)
	return renameWorkspaceConfinedHandle(prior.handle, parent, finalName) == nil
}
