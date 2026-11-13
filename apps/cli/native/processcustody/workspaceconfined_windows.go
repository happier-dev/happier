//go:build windows

package main

import (
	"crypto/rand"
	"crypto/sha1"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"hash"
	"path/filepath"
	"slices"
	"strings"
	"unicode/utf16"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	workspaceConfinedShareMode            = windows.FILE_SHARE_READ | windows.FILE_SHARE_WRITE | windows.FILE_SHARE_DELETE
	workspaceConfinedDirectoryInfoClass   = 12 // FILE_NAMES_INFORMATION
	workspaceConfinedDirectoryBufferBytes = 64 * 1024
)

var workspaceConfinedNtQueryDirectoryFile = windows.NewLazySystemDLL("ntdll.dll").NewProc("NtQueryDirectoryFile")

type workspaceConfinedIdentity struct {
	volumeSerial uint64
	fileID       [16]byte
}

type workspaceConfinedFileIDInfo struct {
	VolumeSerialNumber uint64
	FileID             [16]byte
}

type workspaceConfinedHandle struct {
	handle   windows.Handle
	identity workspaceConfinedIdentity
	kind     workspaceConfinedKind
	info     windows.ByHandleFileInformation
}

type workspaceConfinedHeldPath struct {
	rootPath     string
	components   []string
	handles      []workspaceConfinedHandle // root, followed by every existing component
	missingIndex int                       // -1 when the final object exists
	deleteAccess bool
}

type workspaceConfinedReadOperation struct {
	path    *workspaceConfinedHeldPath
	request workspaceConfinedReadRequest
}

type workspaceConfinedDeleteOperation struct {
	path              *workspaceConfinedHeldPath
	request           workspaceConfinedDeleteRequest
	preconditionError *workspaceConfinedDomainError
}

func prepareWorkspaceConfinedRead(request workspaceConfinedReadRequest) (workspaceConfinedPreparedOperation, *workspaceConfinedDomainError) {
	held, domainErr := openWorkspaceConfinedHeldPath(request.rootPath, request.relativePath, false)
	if domainErr != nil {
		return nil, domainErr
	}
	operation := &workspaceConfinedReadOperation{path: held, request: request}
	if held.missingIndex < 0 {
		final := held.final()
		if final.kind == workspaceConfinedKindFile && request.expectedDigest != "" {
			digest, _, _, digestErr := readWorkspaceConfinedFile(final, false, 0)
			if digestErr != nil {
				held.close()
				return nil, digestErr
			}
			_ = digest // The current digest is re-read after commit before disclosure.
		}
	}
	return operation, nil
}

func prepareWorkspaceConfinedDelete(request workspaceConfinedDeleteRequest) (workspaceConfinedPreparedOperation, *workspaceConfinedDomainError) {
	held, domainErr := openWorkspaceConfinedHeldPath(request.rootPath, request.relativePath, true)
	if domainErr != nil {
		return nil, domainErr
	}
	operation := &workspaceConfinedDeleteOperation{path: held, request: request}
	actualKind := workspaceConfinedKindMissing
	if held.missingIndex < 0 {
		actualKind = held.final().kind
	}
	if actualKind != request.expectedKind {
		operation.preconditionError = workspaceConfinedError("conflict_changed", "conflict loser type changed")
		return operation, nil
	}
	if request.expectedKind == workspaceConfinedKindFile {
		digest, _, _, digestErr := readWorkspaceConfinedFile(held.final(), false, 0)
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

func (operation *workspaceConfinedReadOperation) close() {
	operation.path.close()
}

func (operation *workspaceConfinedReadOperation) commit() workspaceConfinedResult {
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
	current, err := inspectWorkspaceConfinedHandle(final.handle)
	if err != nil || current.kind != final.kind || current.identity != final.identity {
		return workspaceConfinedError("conflict_changed", "workspace file changed before reading").result()
	}
	final.info = current.info
	size := workspaceConfinedFileSize(final.info)
	if size > workspaceConfinedMaxSafeJSONInteger {
		return workspaceConfinedError("workspace_file_unsupported", "workspace file size is not representable").result()
	}
	if size > uint64(operation.request.maxBytes) && operation.request.expectedDigest == "" {
		return workspaceConfinedResult{
			V: 1, T: "workspace-confined-result", Status: "too_large", Size: workspaceConfinedUint64(size),
		}
	}
	digest, content, currentSize, domainErr := readWorkspaceConfinedFile(final, size <= uint64(operation.request.maxBytes), uint64(operation.request.maxBytes))
	if domainErr != nil {
		return domainErr.result()
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

func (operation *workspaceConfinedDeleteOperation) close() {
	operation.path.close()
}

func (operation *workspaceConfinedDeleteOperation) commit() workspaceConfinedResult {
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
	if final.kind != operation.request.expectedKind {
		return workspaceConfinedError("conflict_changed", "conflict loser type changed").result()
	}
	if operation.request.expectedKind == workspaceConfinedKindFile {
		digest, _, _, domainErr := readWorkspaceConfinedFile(final, false, 0)
		if domainErr != nil {
			return domainErr.result()
		}
		if digest != operation.request.expectedDigest {
			return workspaceConfinedError("conflict_changed", "conflict loser digest changed").result()
		}
	}
	parent := operation.path.handles[len(operation.path.handles)-2]
	parentPath, err := workspaceConfinedPhysicalPath(parent.handle)
	if err != nil {
		return workspaceConfinedError("workspace_root_unsafe", "could not resolve the conflict recovery directory").result()
	}
	quarantineName, err := workspaceConfinedQuarantine(final.handle, parent.handle)
	if err != nil {
		return workspaceConfinedError("conflict_changed", "conflict loser changed before quarantine").result()
	}
	recoveryPath := filepath.Join(parentPath, quarantineName)
	if err := deleteWorkspaceConfinedTree(final); err != nil {
		return workspaceConfinedRecoveryError(
			"conflict_changed",
			"conflict loser could not be safely finalized; recovery material remains quarantined",
			recoveryPath,
		).result()
	}
	if err := windows.CloseHandle(final.handle); err != nil {
		return workspaceConfinedRecoveryError(
			"conflict_changed",
			"conflict loser was quarantined but its final handle could not be closed",
			recoveryPath,
		).result()
	}
	operation.path.handles[len(operation.path.handles)-1].handle = 0
	return workspaceConfinedSuccess("deleted")
}

func validateWorkspaceConfinedRelativePath(relativePath string) ([]string, *workspaceConfinedDomainError) {
	if relativePath == "" || strings.IndexByte(relativePath, 0) >= 0 || strings.Contains(relativePath, ":") {
		return nil, workspaceConfinedError("workspace_root_unsafe", "workspace path is not a safe relative path")
	}
	if strings.HasPrefix(relativePath, `\`) || strings.HasPrefix(relativePath, "/") || filepath.IsAbs(relativePath) || filepath.VolumeName(relativePath) != "" {
		return nil, workspaceConfinedError("workspace_root_unsafe", "workspace path is not a safe relative path")
	}
	components := strings.FieldsFunc(relativePath, func(character rune) bool { return character == '\\' || character == '/' })
	separatorCount := strings.Count(relativePath, `\`) + strings.Count(relativePath, "/")
	if len(components) == 0 || separatorCount != len(components)-1 {
		return nil, workspaceConfinedError("workspace_root_unsafe", "workspace path contains an empty component")
	}
	for _, component := range components {
		if component == "" || component == "." || component == ".." || strings.Contains(component, ":") || strings.IndexByte(component, 0) >= 0 {
			return nil, workspaceConfinedError("workspace_root_unsafe", "workspace path contains an unsafe component")
		}
	}
	return components, nil
}

func workspaceConfinedNTAbsolutePath(rootPath string) (string, string, *workspaceConfinedDomainError) {
	if rootPath == "" || strings.IndexByte(rootPath, 0) >= 0 || !filepath.IsAbs(rootPath) {
		return "", "", workspaceConfinedError("workspace_root_unsafe", "workspace root must be an absolute Windows path")
	}
	cleaned := filepath.Clean(rootPath)
	if strings.HasPrefix(cleaned, `\\.\`) {
		return "", "", workspaceConfinedError("workspace_root_unsafe", "workspace root cannot use a Windows device path")
	}
	volume := filepath.VolumeName(cleaned)
	if volume == "" {
		return "", "", workspaceConfinedError("workspace_root_unsafe", "workspace root has no Windows volume")
	}
	if strings.HasPrefix(strings.ToLower(cleaned), `\\?\unc\`) {
		if strings.Contains(cleaned[len(`\\?\UNC\`):], ":") {
			return "", "", workspaceConfinedError("workspace_root_unsafe", "workspace root contains an alternate data stream")
		}
		return cleaned, `\??\UNC\` + cleaned[len(`\\?\UNC\`):], nil
	}
	if strings.HasPrefix(cleaned, `\\?\`) {
		stripped := cleaned[len(`\\?\`):]
		if len(stripped) >= 3 && stripped[1] == ':' && (stripped[2] == '\\' || stripped[2] == '/') {
			if strings.Contains(stripped[2:], ":") {
				return "", "", workspaceConfinedError("workspace_root_unsafe", "workspace root contains an alternate data stream")
			}
		} else {
			return "", "", workspaceConfinedError("workspace_root_unsafe", "workspace root uses an unsupported Windows volume")
		}
		return cleaned, `\??\` + stripped, nil
	}
	if len(volume) == 2 && volume[1] == ':' {
		if strings.Contains(cleaned[2:], ":") {
			return "", "", workspaceConfinedError("workspace_root_unsafe", "workspace root contains an alternate data stream")
		}
		return cleaned, `\??\` + cleaned, nil
	}
	if strings.HasPrefix(cleaned, `\\`) {
		if strings.Contains(cleaned, ":") {
			return "", "", workspaceConfinedError("workspace_root_unsafe", "workspace root contains an alternate data stream")
		}
		return cleaned, `\??\UNC\` + strings.TrimPrefix(cleaned, `\\`), nil
	}
	return "", "", workspaceConfinedError("workspace_root_unsafe", "workspace root uses an unsupported Windows volume")
}

func openWorkspaceConfinedHeldPath(rootPath, relativePath string, deleteAccess bool) (*workspaceConfinedHeldPath, *workspaceConfinedDomainError) {
	components, domainErr := validateWorkspaceConfinedRelativePath(relativePath)
	if domainErr != nil {
		return nil, domainErr
	}
	cleanedRoot, ntRoot, domainErr := workspaceConfinedNTAbsolutePath(rootPath)
	if domainErr != nil {
		return nil, domainErr
	}
	root, err := openWorkspaceConfinedAbsoluteRoot(ntRoot)
	if err != nil {
		return nil, workspaceConfinedError("workspace_root_unsafe", "workspace root could not be opened safely")
	}
	held := &workspaceConfinedHeldPath{
		rootPath: cleanedRoot, components: components, handles: []workspaceConfinedHandle{root}, missingIndex: -1, deleteAccess: deleteAccess,
	}
	parent := root.handle
	for index, component := range components {
		child, err := openWorkspaceConfinedPathComponent(parent, component, index == len(components)-1, deleteAccess)
		if err != nil {
			if workspaceConfinedIsNotFound(err) {
				held.missingIndex = index
				return held, nil
			}
			held.close()
			return nil, workspaceConfinedError("workspace_root_unsafe", "workspace path could not be opened safely")
		}
		if index < len(components)-1 && child.kind != workspaceConfinedKindDirectory {
			windows.CloseHandle(child.handle)
			held.close()
			return nil, workspaceConfinedError("workspace_root_unsafe", "workspace path traverses a non-directory or reparse point")
		}
		held.handles = append(held.handles, child)
		parent = child.handle
	}
	return held, nil
}

func openWorkspaceConfinedAbsoluteRoot(ntPath string) (workspaceConfinedHandle, error) {
	name, err := windows.NewNTUnicodeString(ntPath)
	if err != nil {
		return workspaceConfinedHandle{}, err
	}
	attributes := &windows.OBJECT_ATTRIBUTES{
		Length: uint32(unsafe.Sizeof(windows.OBJECT_ATTRIBUTES{})), ObjectName: name, Attributes: windows.OBJ_CASE_INSENSITIVE,
	}
	var handle windows.Handle
	var status windows.IO_STATUS_BLOCK
	err = windows.NtCreateFile(
		&handle,
		windows.FILE_LIST_DIRECTORY|windows.FILE_TRAVERSE|windows.FILE_READ_ATTRIBUTES|windows.SYNCHRONIZE,
		attributes,
		&status,
		nil,
		0,
		workspaceConfinedShareMode,
		windows.FILE_OPEN,
		windows.FILE_DIRECTORY_FILE|windows.FILE_OPEN_REPARSE_POINT|windows.FILE_SYNCHRONOUS_IO_NONALERT,
		0,
		0,
	)
	if err != nil {
		return workspaceConfinedHandle{}, err
	}
	result, err := inspectWorkspaceConfinedHandle(handle)
	if err != nil {
		windows.CloseHandle(handle)
		return workspaceConfinedHandle{}, err
	}
	if result.kind != workspaceConfinedKindDirectory {
		windows.CloseHandle(handle)
		return workspaceConfinedHandle{}, fmt.Errorf("workspace root is not a real directory")
	}
	return result, nil
}

func openWorkspaceConfinedRelative(parent windows.Handle, component string, deleteAccess bool) (workspaceConfinedHandle, error) {
	return openWorkspaceConfinedPathComponent(parent, component, true, deleteAccess)
}

func openWorkspaceConfinedPathComponent(parent windows.Handle, component string, final bool, deleteAccess bool) (workspaceConfinedHandle, error) {
	if !final {
		return openWorkspaceConfinedRelativeHandle(
			parent,
			component,
			windows.FILE_LIST_DIRECTORY|windows.FILE_TRAVERSE|windows.FILE_READ_ATTRIBUTES|windows.SYNCHRONIZE,
			workspaceConfinedShareMode,
			windows.FILE_DIRECTORY_FILE,
		)
	}
	probe, err := openWorkspaceConfinedRelativeHandle(
		parent,
		component,
		windows.FILE_READ_ATTRIBUTES|windows.SYNCHRONIZE,
		workspaceConfinedShareMode,
		0,
	)
	if err != nil {
		return workspaceConfinedHandle{}, err
	}
	access := uint32(windows.FILE_READ_ATTRIBUTES | windows.SYNCHRONIZE)
	share := uint32(workspaceConfinedShareMode)
	options := uint32(0)
	switch probe.kind {
	case workspaceConfinedKindFile:
		access |= windows.FILE_READ_DATA
		share = windows.FILE_SHARE_READ | windows.FILE_SHARE_DELETE
		options |= windows.FILE_NON_DIRECTORY_FILE
	case workspaceConfinedKindDirectory:
		access |= windows.FILE_LIST_DIRECTORY | windows.FILE_TRAVERSE
		options |= windows.FILE_DIRECTORY_FILE
	case workspaceConfinedKindSymlink:
		share = windows.FILE_SHARE_READ | windows.FILE_SHARE_DELETE
	}
	if deleteAccess {
		access |= windows.DELETE
	}
	reopened, reopenErr := openWorkspaceConfinedRelativeHandle(parent, component, access, share, options)
	_ = windows.CloseHandle(probe.handle)
	if reopenErr != nil {
		return workspaceConfinedHandle{}, reopenErr
	}
	if reopened.identity != probe.identity || reopened.kind != probe.kind {
		_ = windows.CloseHandle(reopened.handle)
		return workspaceConfinedHandle{}, fmt.Errorf("workspace path changed while acquiring final handle")
	}
	return reopened, nil
}

func openWorkspaceConfinedRelativeHandle(parent windows.Handle, component string, access, share, options uint32) (workspaceConfinedHandle, error) {
	name, err := windows.NewNTUnicodeString(component)
	if err != nil {
		return workspaceConfinedHandle{}, err
	}
	attributes := &windows.OBJECT_ATTRIBUTES{
		Length: uint32(unsafe.Sizeof(windows.OBJECT_ATTRIBUTES{})), RootDirectory: parent, ObjectName: name,
	}
	var handle windows.Handle
	var status windows.IO_STATUS_BLOCK
	err = windows.NtCreateFile(
		&handle,
		access,
		attributes,
		&status,
		nil,
		0,
		share,
		windows.FILE_OPEN,
		options|windows.FILE_OPEN_REPARSE_POINT|windows.FILE_SYNCHRONOUS_IO_NONALERT,
		0,
		0,
	)
	if err != nil {
		return workspaceConfinedHandle{}, err
	}
	result, err := inspectWorkspaceConfinedHandle(handle)
	if err != nil {
		windows.CloseHandle(handle)
		return workspaceConfinedHandle{}, err
	}
	return result, nil
}

func inspectWorkspaceConfinedHandle(handle windows.Handle) (workspaceConfinedHandle, error) {
	var info windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(handle, &info); err != nil {
		return workspaceConfinedHandle{}, err
	}
	kind := workspaceConfinedKindFile
	if info.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		kind = workspaceConfinedKindSymlink
	} else if info.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY != 0 {
		kind = workspaceConfinedKindDirectory
	}
	var idInfo workspaceConfinedFileIDInfo
	if err := windows.GetFileInformationByHandleEx(
		handle,
		windows.FileIdInfo,
		(*byte)(unsafe.Pointer(&idInfo)),
		uint32(unsafe.Sizeof(idInfo)),
	); err != nil {
		return workspaceConfinedHandle{}, err
	}
	return workspaceConfinedHandle{
		handle:   handle,
		identity: workspaceConfinedIdentity{volumeSerial: idInfo.VolumeSerialNumber, fileID: idInfo.FileID},
		kind:     kind,
		info:     info,
	}, nil
}

func (path *workspaceConfinedHeldPath) final() workspaceConfinedHandle {
	return path.handles[len(path.handles)-1]
}

func (path *workspaceConfinedHeldPath) close() {
	for index := len(path.handles) - 1; index >= 0; index-- {
		if path.handles[index].handle != 0 {
			_ = windows.CloseHandle(path.handles[index].handle)
		}
	}
	path.handles = nil
}

func (path *workspaceConfinedHeldPath) revalidate() *workspaceConfinedDomainError {
	_, ntRoot, domainErr := workspaceConfinedNTAbsolutePath(path.rootPath)
	if domainErr != nil {
		return domainErr
	}
	current, err := openWorkspaceConfinedAbsoluteRoot(ntRoot)
	if err != nil {
		return workspaceConfinedError("workspace_root_unsafe", "workspace root changed before commit")
	}
	opened := []windows.Handle{current.handle}
	defer func() {
		for index := len(opened) - 1; index >= 0; index-- {
			_ = windows.CloseHandle(opened[index])
		}
	}()
	if current.identity != path.handles[0].identity {
		return workspaceConfinedError("workspace_root_unsafe", "workspace root changed before commit")
	}
	parent := current.handle
	for index, component := range path.components {
		child, err := openWorkspaceConfinedPathComponent(parent, component, index == len(path.components)-1, path.deleteAccess)
		if index == path.missingIndex {
			if workspaceConfinedIsNotFound(err) {
				return nil
			}
			if err == nil {
				windows.CloseHandle(child.handle)
			}
			return workspaceConfinedError("conflict_changed", "workspace path changed before commit")
		}
		if err != nil {
			return workspaceConfinedError("conflict_changed", "workspace path changed before commit")
		}
		opened = append(opened, child.handle)
		expected := path.handles[index+1]
		if child.identity != expected.identity || child.kind != expected.kind {
			return workspaceConfinedError("conflict_changed", "workspace path changed before commit")
		}
		parent = child.handle
	}
	return nil
}

func workspaceConfinedIsNotFound(err error) bool {
	if err == nil {
		return false
	}
	var status windows.NTStatus
	if errors.As(err, &status) {
		return status == windows.STATUS_OBJECT_NAME_NOT_FOUND || status == windows.STATUS_OBJECT_PATH_NOT_FOUND ||
			status.Errno() == windows.ERROR_FILE_NOT_FOUND || status.Errno() == windows.ERROR_PATH_NOT_FOUND
	}
	return errors.Is(err, windows.ERROR_FILE_NOT_FOUND) || errors.Is(err, windows.ERROR_PATH_NOT_FOUND)
}

func workspaceConfinedFileSize(info windows.ByHandleFileInformation) uint64 {
	return uint64(info.FileSizeHigh)<<32 | uint64(info.FileSizeLow)
}

func workspaceConfinedSameFileObservation(first, second windows.ByHandleFileInformation) bool {
	return workspaceConfinedFileSize(first) == workspaceConfinedFileSize(second) &&
		first.LastWriteTime.HighDateTime == second.LastWriteTime.HighDateTime &&
		first.LastWriteTime.LowDateTime == second.LastWriteTime.LowDateTime &&
		first.FileAttributes == second.FileAttributes
}

func readWorkspaceConfinedFile(file workspaceConfinedHandle, capture bool, maxCapture uint64) (string, []byte, uint64, *workspaceConfinedDomainError) {
	if file.kind != workspaceConfinedKindFile {
		return "", nil, 0, workspaceConfinedError("workspace_file_unsupported", "workspace path is not a regular file")
	}
	before, err := inspectWorkspaceConfinedHandle(file.handle)
	if err != nil || before.kind != workspaceConfinedKindFile {
		return "", nil, 0, workspaceConfinedError("conflict_changed", "workspace file changed before reading")
	}
	if _, err := windows.SetFilePointer(file.handle, 0, nil, windows.FILE_BEGIN); err != nil {
		return "", nil, 0, workspaceConfinedError("workspace_file_unsupported", "workspace file cannot be read")
	}
	hasher := sha1.New()
	var content []byte
	if capture {
		initial := workspaceConfinedFileSize(before.info)
		if initial > maxCapture {
			capture = false
		} else {
			content = make([]byte, 0, int(initial))
		}
	}
	total, readErr := readWorkspaceConfinedHandle(file.handle, hasher, &content, capture, maxCapture)
	if readErr != nil {
		return "", nil, 0, workspaceConfinedError("workspace_file_unsupported", "workspace file cannot be read")
	}
	after, err := inspectWorkspaceConfinedHandle(file.handle)
	if err != nil || after.kind != workspaceConfinedKindFile || !workspaceConfinedSameFileObservation(before.info, after.info) || total != workspaceConfinedFileSize(after.info) {
		return "", nil, 0, workspaceConfinedError("conflict_changed", "workspace file changed while reading")
	}
	return hex.EncodeToString(hasher.Sum(nil)), content, total, nil
}

func readWorkspaceConfinedHandle(handle windows.Handle, hasher hash.Hash, content *[]byte, capture bool, maxCapture uint64) (uint64, error) {
	buffer := make([]byte, 64*1024)
	var total uint64
	for {
		var count uint32
		err := windows.ReadFile(handle, buffer, &count, nil)
		if count > 0 {
			chunk := buffer[:count]
			_, _ = hasher.Write(chunk)
			total += uint64(count)
			if capture {
				if total > maxCapture {
					capture = false
					*content = nil
				} else {
					*content = append(*content, chunk...)
				}
			}
		}
		if err != nil {
			if errors.Is(err, windows.ERROR_HANDLE_EOF) {
				return total, nil
			}
			return 0, err
		}
		if count == 0 {
			return total, nil
		}
	}
}

type workspaceConfinedRenameInformation struct {
	ReplaceIfExists uint32
	RootDirectory   windows.Handle
	FileNameLength  uint32
	FileName        [1]uint16
}

func workspaceConfinedQuarantine(target, parent windows.Handle) (string, error) {
	for attempt := 0; attempt < 8; attempt++ {
		randomBytes := make([]byte, 16)
		if _, err := rand.Read(randomBytes); err != nil {
			return "", err
		}
		name := ".happier-conflict-quarantine-" + hex.EncodeToString(randomBytes)
		if err := renameWorkspaceConfinedHandle(target, parent, name); err != nil {
			var status windows.NTStatus
			if errors.As(err, &status) && (status == windows.STATUS_OBJECT_NAME_COLLISION || status == windows.STATUS_OBJECT_NAME_EXISTS) {
				continue
			}
			return "", err
		}
		return name, nil
	}
	return "", fmt.Errorf("could not create a unique quarantine name")
}

func renameWorkspaceConfinedHandle(target, parent windows.Handle, name string) error {
	utf16Name, err := windows.UTF16FromString(name)
	if err != nil {
		return err
	}
	nameBytes := (len(utf16Name) - 1) * 2
	var layout workspaceConfinedRenameInformation
	buffer := make([]byte, int(unsafe.Offsetof(layout.FileName))+nameBytes)
	information := (*workspaceConfinedRenameInformation)(unsafe.Pointer(&buffer[0]))
	information.ReplaceIfExists = 0
	information.RootDirectory = parent
	information.FileNameLength = uint32(nameBytes)
	copy(unsafe.Slice((*uint16)(unsafe.Pointer(&information.FileName[0])), nameBytes/2), utf16Name[:len(utf16Name)-1])
	var status windows.IO_STATUS_BLOCK
	return windows.NtSetInformationFile(target, &status, &buffer[0], uint32(len(buffer)), windows.FileRenameInformation)
}

func deleteWorkspaceConfinedTree(target workspaceConfinedHandle) error {
	if target.kind == workspaceConfinedKindDirectory {
		names, err := listWorkspaceConfinedDirectory(target.handle)
		if err != nil {
			return err
		}
		for _, name := range names {
			child, err := openWorkspaceConfinedRelative(target.handle, name, true)
			if err != nil {
				if workspaceConfinedIsNotFound(err) {
					continue
				}
				return err
			}
			if err := deleteWorkspaceConfinedTree(child); err != nil {
				_ = windows.CloseHandle(child.handle)
				return err
			}
			if err := windows.CloseHandle(child.handle); err != nil {
				return err
			}
		}
	}
	return disposeWorkspaceConfinedHandle(target.handle)
}

func listWorkspaceConfinedDirectory(directory windows.Handle) ([]string, error) {
	buffer := make([]byte, workspaceConfinedDirectoryBufferBytes)
	var result []string
	restart := uintptr(1)
	for {
		var statusBlock windows.IO_STATUS_BLOCK
		statusValue, _, _ := workspaceConfinedNtQueryDirectoryFile.Call(
			uintptr(directory),
			0,
			0,
			0,
			uintptr(unsafe.Pointer(&statusBlock)),
			uintptr(unsafe.Pointer(&buffer[0])),
			uintptr(len(buffer)),
			workspaceConfinedDirectoryInfoClass,
			0,
			0,
			restart,
		)
		restart = 0
		status := windows.NTStatus(statusValue)
		if status == windows.STATUS_NO_MORE_FILES {
			return result, nil
		}
		if status != 0 && status != windows.STATUS_BUFFER_OVERFLOW {
			return nil, status
		}
		used := int(statusBlock.Information)
		if used <= 0 || used > len(buffer) {
			return nil, fmt.Errorf("invalid directory enumeration result")
		}
		for offset := 0; ; {
			if offset+12 > used {
				return nil, fmt.Errorf("invalid directory enumeration record")
			}
			next := *(*uint32)(unsafe.Pointer(&buffer[offset]))
			nameBytes := *(*uint32)(unsafe.Pointer(&buffer[offset+8]))
			if nameBytes%2 != 0 || int(nameBytes) > used-(offset+12) {
				return nil, fmt.Errorf("invalid directory entry name")
			}
			nameWords := unsafe.Slice((*uint16)(unsafe.Pointer(&buffer[offset+12])), int(nameBytes/2))
			name, err := decodeWorkspaceConfinedWindowsDirectoryName(nameWords)
			if err != nil {
				return nil, err
			}
			if name != "." && name != ".." {
				if _, domainErr := validateWorkspaceConfinedRelativePath(name); domainErr != nil || strings.ContainsAny(name, `\/`) {
					return nil, fmt.Errorf("unsafe directory entry name")
				}
				result = append(result, name)
			}
			if next == 0 {
				break
			}
			if next%4 != 0 || int(next) > used-offset {
				return nil, fmt.Errorf("invalid directory enumeration offset")
			}
			offset += int(next)
		}
	}
}

func decodeWorkspaceConfinedWindowsDirectoryName(nameWords []uint16) (string, error) {
	decoded := utf16.Decode(nameWords)
	if !slices.Equal(utf16.Encode(decoded), nameWords) {
		return "", fmt.Errorf("directory entry name cannot be represented without changing its identity")
	}
	return string(decoded), nil
}

func disposeWorkspaceConfinedHandle(handle windows.Handle) error {
	flags := uint32(
		windows.FILE_DISPOSITION_DELETE |
			windows.FILE_DISPOSITION_POSIX_SEMANTICS |
			windows.FILE_DISPOSITION_IGNORE_READONLY_ATTRIBUTE,
	)
	return windows.SetFileInformationByHandle(
		handle,
		windows.FileDispositionInfoEx,
		(*byte)(unsafe.Pointer(&flags)),
		uint32(unsafe.Sizeof(flags)),
	)
}

func workspaceConfinedPhysicalPath(handle windows.Handle) (string, error) {
	buffer := make([]uint16, 32768)
	length, err := windows.GetFinalPathNameByHandle(handle, &buffer[0], uint32(len(buffer)), 0)
	if err != nil {
		return "", err
	}
	if length == 0 || length >= uint32(len(buffer)) {
		return "", fmt.Errorf("invalid final path length")
	}
	path := windows.UTF16ToString(buffer[:length])
	if strings.HasPrefix(strings.ToLower(path), `\\?\unc\`) {
		return `\\` + path[len(`\\?\UNC\`):], nil
	}
	return strings.TrimPrefix(path, `\\?\`), nil
}
