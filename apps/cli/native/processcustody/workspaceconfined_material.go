package main

import (
	"crypto/sha1"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"hash"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"
)

type workspaceConfinedFingerprintWriter struct {
	hasher hash.Hash
	first  bool
}

func newWorkspaceConfinedFingerprintWriter() *workspaceConfinedFingerprintWriter {
	writer := &workspaceConfinedFingerprintWriter{hasher: sha256.New(), first: true}
	_, _ = io.WriteString(writer.hasher, `{"v":1,"entries":[`)
	return writer
}

func writeWorkspaceConfinedJSONString(writer io.Writer, value string) {
	_, _ = io.WriteString(writer, `"`)
	for _, char := range value {
		switch char {
		case '"':
			_, _ = io.WriteString(writer, `\"`)
		case '\\':
			_, _ = io.WriteString(writer, `\\`)
		case '\b':
			_, _ = io.WriteString(writer, `\b`)
		case '\f':
			_, _ = io.WriteString(writer, `\f`)
		case '\n':
			_, _ = io.WriteString(writer, `\n`)
		case '\r':
			_, _ = io.WriteString(writer, `\r`)
		case '\t':
			_, _ = io.WriteString(writer, `\t`)
		default:
			if char < 0x20 {
				_, _ = io.WriteString(writer, `\u`+fmt.Sprintf("%04x", char))
			} else {
				_, _ = io.WriteString(writer, string(char))
			}
		}
	}
	_, _ = io.WriteString(writer, `"`)
}

func (writer *workspaceConfinedFingerprintWriter) add(name string, entry workspaceConfinedExpectation) {
	if !writer.first {
		_, _ = io.WriteString(writer.hasher, ",")
	}
	writer.first = false
	_, _ = io.WriteString(writer.hasher, "[")
	writeWorkspaceConfinedJSONString(writer.hasher, name)
	_, _ = io.WriteString(writer.hasher, `,{"kind":`)
	writeWorkspaceConfinedJSONString(writer.hasher, string(entry.Kind))
	switch entry.Kind {
	case workspaceConfinedKindFile:
		_, _ = io.WriteString(writer.hasher, `,"digest":`)
		writeWorkspaceConfinedJSONString(writer.hasher, entry.Digest)
		_, _ = io.WriteString(writer.hasher, `,"executable":`)
		_, _ = io.WriteString(writer.hasher, strconv.FormatBool(*entry.Executable))
		_, _ = io.WriteString(writer.hasher, `,"size":`)
		_, _ = io.WriteString(writer.hasher, strconv.FormatUint(*entry.Size, 10))
	case workspaceConfinedKindSymlink:
		_, _ = io.WriteString(writer.hasher, `,"target":`)
		writeWorkspaceConfinedJSONString(writer.hasher, entry.Target)
	case workspaceConfinedKindDirectory:
		_, _ = io.WriteString(writer.hasher, `,"fingerprint":`)
		writeWorkspaceConfinedJSONString(writer.hasher, entry.Fingerprint)
	}
	_, _ = io.WriteString(writer.hasher, "}]")
}

func (writer *workspaceConfinedFingerprintWriter) finish() string {
	_, _ = io.WriteString(writer.hasher, "]}")
	return hex.EncodeToString(writer.hasher.Sum(nil))
}

type workspaceConfinedRecoveryRecord struct {
	V                   int                          `json:"v"`
	OperationID         string                       `json:"operationId"`
	RootPath            string                       `json:"rootPath"`
	RootIdentity        string                       `json:"rootIdentity"`
	RelativePath        string                       `json:"relativePath"`
	ExpectedDestination workspaceConfinedExpectation `json:"expectedDestination"`
	SelectedExpectation workspaceConfinedExpectation `json:"selectedExpectation"`
	CandidateName       string                       `json:"candidateName"`
	PriorName           string                       `json:"priorName"`
}

func workspaceConfinedObservedResult(expectation workspaceConfinedExpectation) workspaceConfinedResult {
	return workspaceConfinedResult{V: 1, T: "workspace-confined-result", Status: "observed", Expectation: &expectation}
}

func workspaceConfinedMeasuredResult(sizeBytes uint64) workspaceConfinedResult {
	return workspaceConfinedResult{V: 1, T: "workspace-confined-result", Status: "measured", SizeBytes: &sizeBytes}
}

func addWorkspaceConfinedMeasuredBytes(total *uint64, size uint64) *workspaceConfinedDomainError {
	if ^uint64(0)-*total < size {
		return workspaceConfinedError("workspace_file_unsupported", "workspace size cannot be represented")
	}
	*total += size
	return nil
}

func workspaceConfinedCapturedResult(expectation workspaceConfinedExpectation, materialPath *string) workspaceConfinedResult {
	material := json.RawMessage("null")
	if materialPath != nil {
		material, _ = json.Marshal(*materialPath)
	}
	return workspaceConfinedResult{V: 1, T: "workspace-confined-result", Status: "captured", Expectation: &expectation, MaterialPath: material}
}

func workspaceConfinedRecoveryNeeded(path string) workspaceConfinedResult {
	return workspaceConfinedResult{V: 1, T: "workspace-confined-result", Status: "recovery_needed", RecoveryPath: path}
}

func workspaceConfinedValidatePrivateDirectory(path string) (string, *workspaceConfinedDomainError) {
	if path == "" || strings.IndexByte(path, 0) >= 0 || !filepath.IsAbs(path) {
		return "", workspaceConfinedError("workspace_root_unsafe", "private workspace material directory must be absolute")
	}
	cleaned := filepath.Clean(path)
	info, err := os.Lstat(cleaned)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return "", workspaceConfinedError("workspace_root_unsafe", "private workspace material directory is unavailable")
	}
	return cleaned, nil
}

func workspaceConfinedMaterialPath(directory, operationID string) string {
	return filepath.Join(directory, "workspace-entry-"+operationID)
}

func workspaceConfinedRecoveryRecordPath(directory, operationID string) string {
	return filepath.Join(directory, "workspace-recovery-"+operationID+".json")
}

func workspaceConfinedWriteRecoveryRecord(path string, record workspaceConfinedRecoveryRecord) error {
	encoded, err := json.Marshal(record)
	if err != nil {
		return err
	}
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	_, writeErr := file.Write(encoded)
	syncErr := file.Sync()
	closeErr := file.Close()
	if writeErr != nil {
		return writeErr
	}
	if syncErr != nil {
		return syncErr
	}
	return closeErr
}

func workspaceConfinedReadRecoveryRecord(path string) (workspaceConfinedRecoveryRecord, error) {
	encoded, err := os.ReadFile(path)
	if err != nil {
		return workspaceConfinedRecoveryRecord{}, err
	}
	decoder := json.NewDecoder(strings.NewReader(string(encoded)))
	decoder.DisallowUnknownFields()
	var record workspaceConfinedRecoveryRecord
	if err := decoder.Decode(&record); err != nil {
		return workspaceConfinedRecoveryRecord{}, err
	}
	var trailing json.RawMessage
	if err := decoder.Decode(&trailing); err != io.EOF {
		return workspaceConfinedRecoveryRecord{}, fmt.Errorf("invalid trailing recovery record data")
	}
	if record.V != 1 || !workspaceConfinedOperationIDPattern.MatchString(record.OperationID) || record.RelativePath == "" || record.RootIdentity == "" ||
		!filepath.IsAbs(record.RootPath) ||
		record.CandidateName != ".happier-conflict-resolution-"+record.OperationID+"-selected" ||
		record.PriorName != ".happier-conflict-resolution-"+record.OperationID+"-prior" {
		return workspaceConfinedRecoveryRecord{}, fmt.Errorf("invalid recovery record")
	}
	if _, err := decodeWorkspaceConfinedExpectation(mustMarshalWorkspaceConfinedExpectation(record.ExpectedDestination)); err != nil {
		return workspaceConfinedRecoveryRecord{}, err
	}
	if _, err := decodeWorkspaceConfinedExpectation(mustMarshalWorkspaceConfinedExpectation(record.SelectedExpectation)); err != nil {
		return workspaceConfinedRecoveryRecord{}, err
	}
	return record, nil
}

type workspaceConfinedInspectOperation struct {
	recordPath  string
	operationID string
}

func prepareWorkspaceConfinedInspect(request workspaceConfinedInspectRequest) (workspaceConfinedPreparedOperation, *workspaceConfinedDomainError) {
	directory, err := workspaceConfinedValidatePrivateDirectory(request.recoveryDirectory)
	if err != nil {
		return nil, err
	}
	return &workspaceConfinedInspectOperation{
		recordPath:  workspaceConfinedRecoveryRecordPath(directory, request.operationID),
		operationID: request.operationID,
	}, nil
}

func (o *workspaceConfinedInspectOperation) close() {}

func (o *workspaceConfinedInspectOperation) commit() workspaceConfinedResult {
	record, err := workspaceConfinedReadRecoveryRecord(o.recordPath)
	if err != nil || record.OperationID != o.operationID {
		return workspaceConfinedRecoveryError("workspace_root_unsafe", "workspace recovery record could not be inspected", o.recordPath).result()
	}
	return workspaceConfinedResult{V: 1, T: "workspace-confined-result", Status: "recovery_record", RootPath: record.RootPath, OperationID: record.OperationID}
}

func workspaceConfinedDisplacedMatches(path string, expected workspaceConfinedExpectation) bool {
	if expected.Kind == workspaceConfinedKindMissing {
		return true
	}
	observed, err := observeWorkspaceConfinedPrivateMaterial(path)
	return err == nil && workspaceConfinedExpectationsEqual(observed, expected)
}

func workspaceConfinedDisplacedMatchesOrWasCleaned(path string, expected workspaceConfinedExpectation) bool {
	observed, err := observeWorkspaceConfinedPrivateMaterial(path)
	return err == nil && (observed.Kind == workspaceConfinedKindMissing || workspaceConfinedExpectationsEqual(observed, expected))
}

func mustMarshalWorkspaceConfinedExpectation(expectation workspaceConfinedExpectation) json.RawMessage {
	encoded, _ := json.Marshal(expectation)
	return encoded
}

func observeWorkspaceConfinedPrivateMaterial(path string) (workspaceConfinedExpectation, error) {
	info, err := os.Lstat(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return workspaceConfinedExpectation{Kind: workspaceConfinedKindMissing}, nil
		}
		return workspaceConfinedExpectation{}, err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		target, err := os.Readlink(path)
		if err != nil {
			return workspaceConfinedExpectation{}, err
		}
		if !utf8.ValidString(target) {
			return workspaceConfinedExpectation{}, fmt.Errorf("private material has an unrepresentable symlink target")
		}
		return workspaceConfinedExpectation{Kind: workspaceConfinedKindSymlink, Target: target}, nil
	}
	if info.Mode().IsRegular() {
		file, err := os.Open(path)
		if err != nil {
			return workspaceConfinedExpectation{}, err
		}
		hasher := sha1.New()
		size, copyErr := io.Copy(hasher, file)
		closeErr := file.Close()
		if copyErr != nil {
			return workspaceConfinedExpectation{}, copyErr
		}
		if closeErr != nil {
			return workspaceConfinedExpectation{}, closeErr
		}
		after, err := os.Lstat(path)
		if err != nil || !after.Mode().IsRegular() || !os.SameFile(info, after) || info.Size() != after.Size() || size != after.Size() || info.ModTime() != after.ModTime() {
			return workspaceConfinedExpectation{}, fmt.Errorf("private material changed while reading")
		}
		if size < 0 || uint64(size) > uint64(1<<53-1) {
			return workspaceConfinedExpectation{}, fmt.Errorf("private material size is invalid")
		}
		executable := after.Mode().Perm()&0o111 != 0
		safeSize := uint64(size)
		return workspaceConfinedExpectation{Kind: workspaceConfinedKindFile, Digest: hex.EncodeToString(hasher.Sum(nil)), Executable: &executable, Size: &safeSize}, nil
	}
	if !info.IsDir() {
		return workspaceConfinedExpectation{}, fmt.Errorf("private material type is unsupported")
	}
	names, err := os.ReadDir(path)
	if err != nil {
		return workspaceConfinedExpectation{}, err
	}
	sort.Slice(names, func(i, j int) bool { return names[i].Name() < names[j].Name() })
	fingerprint := newWorkspaceConfinedFingerprintWriter()
	for _, entry := range names {
		name := entry.Name()
		if name == "" || name == "." || name == ".." || strings.ContainsAny(name, `/\\`) || strings.IndexByte(name, 0) >= 0 || !utf8.ValidString(name) {
			return workspaceConfinedExpectation{}, fmt.Errorf("private material has an unsafe child name")
		}
		child, err := observeWorkspaceConfinedPrivateMaterial(filepath.Join(path, name))
		if err != nil {
			return workspaceConfinedExpectation{}, err
		}
		fingerprint.add(name, child)
	}
	return workspaceConfinedExpectation{Kind: workspaceConfinedKindDirectory, Fingerprint: fingerprint.finish()}, nil
}

func copyWorkspaceConfinedPrivateMaterial(source, destination string) error {
	info, err := os.Lstat(source)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		target, err := os.Readlink(source)
		if err != nil {
			return err
		}
		return os.Symlink(target, destination)
	}
	if info.Mode().IsRegular() {
		input, err := os.Open(source)
		if err != nil {
			return err
		}
		output, err := os.OpenFile(destination, os.O_WRONLY|os.O_CREATE|os.O_EXCL, info.Mode().Perm())
		if err != nil {
			_ = input.Close()
			return err
		}
		_, copyErr := io.Copy(output, input)
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
	}
	if !info.IsDir() {
		return fmt.Errorf("private material type is unsupported")
	}
	if err := os.Mkdir(destination, info.Mode().Perm()); err != nil {
		return err
	}
	entries, err := os.ReadDir(source)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if err := copyWorkspaceConfinedPrivateMaterial(filepath.Join(source, entry.Name()), filepath.Join(destination, entry.Name())); err != nil {
			return err
		}
	}
	return nil
}

func removeWorkspaceConfinedPrivateMaterial(path string) error {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if info.IsDir() && info.Mode()&os.ModeSymlink == 0 {
		entries, err := os.ReadDir(path)
		if err != nil {
			return err
		}
		for _, entry := range entries {
			if err := removeWorkspaceConfinedPrivateMaterial(filepath.Join(path, entry.Name())); err != nil {
				return err
			}
		}
	}
	return os.Remove(path)
}
