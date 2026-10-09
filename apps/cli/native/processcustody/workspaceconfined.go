package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"regexp"
	"strings"
)

const (
	workspaceConfinedMaxRequestBytes = 64 * 1024
	workspaceConfinedMaxPreviewBytes = 1024 * 1024
)

type workspaceConfinedKind string

const (
	workspaceConfinedKindMissing   workspaceConfinedKind = "missing"
	workspaceConfinedKindFile      workspaceConfinedKind = "file"
	workspaceConfinedKindDirectory workspaceConfinedKind = "directory"
	workspaceConfinedKindSymlink   workspaceConfinedKind = "symlink"
)

var workspaceConfinedDigestPattern = regexp.MustCompile(`^[0-9a-f]{40}$`)
var workspaceConfinedFingerprintPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)
var workspaceConfinedOperationIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)

type workspaceConfinedExpectation struct {
	Kind        workspaceConfinedKind `json:"kind"`
	Digest      string                `json:"digest,omitempty"`
	Executable  *bool                 `json:"executable,omitempty"`
	Size        *uint64               `json:"size,omitempty"`
	Target      string                `json:"target,omitempty"`
	Fingerprint string                `json:"fingerprint,omitempty"`
}

type workspaceConfinedReadRequest struct {
	rootPath       string
	relativePath   string
	maxBytes       int64
	expectedDigest string
}

type workspaceConfinedDeleteRequest struct {
	rootPath       string
	relativePath   string
	expectedKind   workspaceConfinedKind
	expectedDigest string
}

type workspaceConfinedObserveRequest struct {
	rootPath     string
	relativePath string
	measureSize  bool
}

type workspaceConfinedCaptureRequest struct {
	rootPath         string
	relativePath     string
	expected         workspaceConfinedExpectation
	captureDirectory string
	operationID      string
}

type workspaceConfinedApplyRequest struct {
	rootPath            string
	relativePath        string
	expectedDestination workspaceConfinedExpectation
	selectedExpectation workspaceConfinedExpectation
	materialPath        *string
	recoveryDirectory   string
	operationID         string
}

type workspaceConfinedRecoverRequest struct {
	rootPath          string
	recoveryDirectory string
	operationID       string
}

type workspaceConfinedInspectRequest struct {
	recoveryDirectory string
	operationID       string
}

type workspaceConfinedPreparedOperation interface {
	commit() workspaceConfinedResult
	close()
}

type workspaceConfinedResult struct {
	V             int                           `json:"v"`
	T             string                        `json:"t"`
	Status        string                        `json:"status"`
	ActualDigest  string                        `json:"actualDigest,omitempty"`
	Size          *uint64                       `json:"size,omitempty"`
	SizeBytes     *uint64                       `json:"sizeBytes,omitempty"`
	Digest        string                        `json:"digest,omitempty"`
	ContentBase64 *string                       `json:"contentBase64,omitempty"`
	Code          string                        `json:"code,omitempty"`
	Message       string                        `json:"message,omitempty"`
	RecoveryPath  string                        `json:"recoveryPath,omitempty"`
	RootPath      string                        `json:"rootPath,omitempty"`
	OperationID   string                        `json:"operationId,omitempty"`
	Expectation   *workspaceConfinedExpectation `json:"expectation,omitempty"`
	MaterialPath  json.RawMessage               `json:"materialPath,omitempty"`
}

type workspaceConfinedDomainError struct {
	code         string
	message      string
	recoveryPath string
}

func workspaceConfinedError(code, message string) *workspaceConfinedDomainError {
	return &workspaceConfinedDomainError{code: code, message: message}
}

func workspaceConfinedRecoveryError(code, message, recoveryPath string) *workspaceConfinedDomainError {
	return &workspaceConfinedDomainError{code: code, message: message, recoveryPath: recoveryPath}
}

func (e *workspaceConfinedDomainError) result() workspaceConfinedResult {
	return workspaceConfinedResult{
		V:            1,
		T:            "workspace-confined-result",
		Status:       "error",
		Code:         e.code,
		Message:      e.message,
		RecoveryPath: e.recoveryPath,
	}
}

func workspaceConfinedSuccess(status string) workspaceConfinedResult {
	return workspaceConfinedResult{V: 1, T: "workspace-confined-result", Status: status}
}

func workspaceConfinedString(value string) *string {
	return &value
}

func decodeClosedWorkspaceConfinedObject(encoded []byte, allowed map[string]bool) (map[string]json.RawMessage, error) {
	decoder := json.NewDecoder(bytes.NewReader(encoded))
	token, err := decoder.Token()
	if err != nil {
		return nil, err
	}
	delimiter, ok := token.(json.Delim)
	if !ok || delimiter != '{' {
		return nil, fmt.Errorf("JSON value must be an object")
	}
	result := make(map[string]json.RawMessage, len(allowed))
	for decoder.More() {
		token, err = decoder.Token()
		if err != nil {
			return nil, err
		}
		key, ok := token.(string)
		if !ok || !allowed[key] {
			return nil, fmt.Errorf("unknown field")
		}
		if _, duplicate := result[key]; duplicate {
			return nil, fmt.Errorf("duplicate field")
		}
		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil {
			return nil, err
		}
		result[key] = value
	}
	if _, err := decoder.Token(); err != nil {
		return nil, err
	}
	if decoder.More() {
		return nil, fmt.Errorf("unexpected trailing JSON")
	}
	var trailing json.RawMessage
	if err := decoder.Decode(&trailing); err != io.EOF {
		if err == nil {
			return nil, fmt.Errorf("unexpected trailing JSON")
		}
		return nil, err
	}
	return result, nil
}

func decodeRequiredString(fields map[string]json.RawMessage, key string) (string, error) {
	encoded, ok := fields[key]
	if !ok {
		return "", fmt.Errorf("missing %s", key)
	}
	var value string
	if err := json.Unmarshal(encoded, &value); err != nil {
		return "", fmt.Errorf("invalid %s", key)
	}
	return value, nil
}

func decodeVersion(fields map[string]json.RawMessage) error {
	encoded, ok := fields["v"]
	if !ok {
		return fmt.Errorf("unsupported protocol version")
	}
	var version int
	if err := json.Unmarshal(encoded, &version); err != nil || version != 1 {
		return fmt.Errorf("unsupported protocol version")
	}
	return nil
}

func decodeOptionalDigest(fields map[string]json.RawMessage) (string, error) {
	encoded, ok := fields["expectedDigest"]
	if !ok {
		return "", nil
	}
	var value string
	if err := json.Unmarshal(encoded, &value); err != nil || !workspaceConfinedDigestPattern.MatchString(value) {
		return "", fmt.Errorf("invalid expectedDigest")
	}
	return value, nil
}

func decodeWorkspaceConfinedExpectation(encoded json.RawMessage) (workspaceConfinedExpectation, error) {
	base, err := decodeClosedWorkspaceConfinedObject(encoded, map[string]bool{
		"kind": true, "digest": true, "executable": true, "size": true, "target": true, "fingerprint": true,
	})
	if err != nil {
		return workspaceConfinedExpectation{}, err
	}
	kindValue, err := decodeRequiredString(base, "kind")
	if err != nil {
		return workspaceConfinedExpectation{}, err
	}
	expectation := workspaceConfinedExpectation{Kind: workspaceConfinedKind(kindValue)}
	switch expectation.Kind {
	case workspaceConfinedKindMissing:
		if len(base) != 1 {
			return workspaceConfinedExpectation{}, fmt.Errorf("missing expectation has extra fields")
		}
	case workspaceConfinedKindFile:
		if len(base) != 4 {
			return workspaceConfinedExpectation{}, fmt.Errorf("file expectation fields are incomplete")
		}
		digest, err := decodeRequiredString(base, "digest")
		if err != nil || !workspaceConfinedDigestPattern.MatchString(digest) {
			return workspaceConfinedExpectation{}, fmt.Errorf("invalid file digest")
		}
		var executable bool
		if encoded, ok := base["executable"]; !ok || json.Unmarshal(encoded, &executable) != nil {
			return workspaceConfinedExpectation{}, fmt.Errorf("invalid executable state")
		}
		var size uint64
		if encoded, ok := base["size"]; !ok || json.Unmarshal(encoded, &size) != nil || size > uint64(1<<53-1) {
			return workspaceConfinedExpectation{}, fmt.Errorf("invalid file size")
		}
		expectation.Digest = digest
		expectation.Executable = &executable
		expectation.Size = &size
	case workspaceConfinedKindSymlink:
		if len(base) != 2 {
			return workspaceConfinedExpectation{}, fmt.Errorf("symlink expectation fields are incomplete")
		}
		target, err := decodeRequiredString(base, "target")
		if err != nil || strings.IndexByte(target, 0) >= 0 || len(target) > 4096 {
			return workspaceConfinedExpectation{}, fmt.Errorf("invalid symlink target")
		}
		expectation.Target = target
	case workspaceConfinedKindDirectory:
		if len(base) != 2 {
			return workspaceConfinedExpectation{}, fmt.Errorf("directory expectation fields are incomplete")
		}
		fingerprint, err := decodeRequiredString(base, "fingerprint")
		if err != nil || !workspaceConfinedFingerprintPattern.MatchString(fingerprint) {
			return workspaceConfinedExpectation{}, fmt.Errorf("invalid directory fingerprint")
		}
		expectation.Fingerprint = fingerprint
	default:
		return workspaceConfinedExpectation{}, fmt.Errorf("invalid expectation kind")
	}
	return expectation, nil
}

func workspaceConfinedExpectationsEqual(first, second workspaceConfinedExpectation) bool {
	if first.Kind != second.Kind || first.Digest != second.Digest || first.Target != second.Target || first.Fingerprint != second.Fingerprint {
		return false
	}
	if (first.Executable == nil) != (second.Executable == nil) || (first.Size == nil) != (second.Size == nil) {
		return false
	}
	return (first.Executable == nil || *first.Executable == *second.Executable) && (first.Size == nil || *first.Size == *second.Size)
}

func decodeWorkspaceConfinedOperationID(fields map[string]json.RawMessage) (string, error) {
	operationID, err := decodeRequiredString(fields, "operationId")
	if err != nil || !workspaceConfinedOperationIDPattern.MatchString(operationID) {
		return "", fmt.Errorf("invalid operationId")
	}
	return operationID, nil
}

func decodeWorkspaceConfinedObserveRequest(encoded []byte) (workspaceConfinedObserveRequest, error) {
	fields, err := decodeClosedWorkspaceConfinedObject(encoded, map[string]bool{"v": true, "rootPath": true, "relativePath": true, "measureSize": true})
	if err != nil || decodeVersion(fields) != nil {
		return workspaceConfinedObserveRequest{}, fmt.Errorf("invalid observe request")
	}
	rootPath, err := decodeRequiredString(fields, "rootPath")
	if err != nil {
		return workspaceConfinedObserveRequest{}, err
	}
	relativePath, err := decodeRequiredString(fields, "relativePath")
	if err != nil {
		return workspaceConfinedObserveRequest{}, err
	}
	measureSize := false
	if encoded, present := fields["measureSize"]; present {
		if err := json.Unmarshal(encoded, &measureSize); err != nil || !measureSize {
			return workspaceConfinedObserveRequest{}, fmt.Errorf("invalid passive measurement mode")
		}
	}
	return workspaceConfinedObserveRequest{rootPath: rootPath, relativePath: relativePath, measureSize: measureSize}, nil
}

func decodeWorkspaceConfinedCaptureRequest(encoded []byte) (workspaceConfinedCaptureRequest, error) {
	fields, err := decodeClosedWorkspaceConfinedObject(encoded, map[string]bool{
		"v": true, "rootPath": true, "relativePath": true, "expected": true, "captureDirectory": true, "operationId": true,
	})
	if err != nil || decodeVersion(fields) != nil {
		return workspaceConfinedCaptureRequest{}, fmt.Errorf("invalid capture request")
	}
	rootPath, err := decodeRequiredString(fields, "rootPath")
	if err != nil {
		return workspaceConfinedCaptureRequest{}, err
	}
	relativePath, err := decodeRequiredString(fields, "relativePath")
	if err != nil {
		return workspaceConfinedCaptureRequest{}, err
	}
	captureDirectory, err := decodeRequiredString(fields, "captureDirectory")
	if err != nil {
		return workspaceConfinedCaptureRequest{}, err
	}
	operationID, err := decodeWorkspaceConfinedOperationID(fields)
	if err != nil {
		return workspaceConfinedCaptureRequest{}, err
	}
	expectedEncoded, ok := fields["expected"]
	if !ok {
		return workspaceConfinedCaptureRequest{}, fmt.Errorf("missing expected")
	}
	expected, err := decodeWorkspaceConfinedExpectation(expectedEncoded)
	if err != nil {
		return workspaceConfinedCaptureRequest{}, err
	}
	return workspaceConfinedCaptureRequest{rootPath: rootPath, relativePath: relativePath, expected: expected, captureDirectory: captureDirectory, operationID: operationID}, nil
}

func decodeWorkspaceConfinedApplyRequest(encoded []byte) (workspaceConfinedApplyRequest, error) {
	fields, err := decodeClosedWorkspaceConfinedObject(encoded, map[string]bool{
		"v": true, "rootPath": true, "relativePath": true, "expectedDestination": true, "selectedExpectation": true,
		"materialPath": true, "recoveryDirectory": true, "operationId": true,
	})
	if err != nil || decodeVersion(fields) != nil {
		return workspaceConfinedApplyRequest{}, fmt.Errorf("invalid apply request")
	}
	rootPath, err := decodeRequiredString(fields, "rootPath")
	if err != nil {
		return workspaceConfinedApplyRequest{}, err
	}
	relativePath, err := decodeRequiredString(fields, "relativePath")
	if err != nil {
		return workspaceConfinedApplyRequest{}, err
	}
	recoveryDirectory, err := decodeRequiredString(fields, "recoveryDirectory")
	if err != nil {
		return workspaceConfinedApplyRequest{}, err
	}
	operationID, err := decodeWorkspaceConfinedOperationID(fields)
	if err != nil {
		return workspaceConfinedApplyRequest{}, err
	}
	destinationEncoded, ok := fields["expectedDestination"]
	if !ok {
		return workspaceConfinedApplyRequest{}, fmt.Errorf("missing expectedDestination")
	}
	expectedDestination, err := decodeWorkspaceConfinedExpectation(destinationEncoded)
	if err != nil {
		return workspaceConfinedApplyRequest{}, err
	}
	selectedEncoded, ok := fields["selectedExpectation"]
	if !ok {
		return workspaceConfinedApplyRequest{}, fmt.Errorf("missing selectedExpectation")
	}
	selected, err := decodeWorkspaceConfinedExpectation(selectedEncoded)
	if err != nil {
		return workspaceConfinedApplyRequest{}, err
	}
	materialEncoded, ok := fields["materialPath"]
	if !ok {
		return workspaceConfinedApplyRequest{}, fmt.Errorf("missing materialPath")
	}
	var materialPath *string
	if string(materialEncoded) != "null" {
		var material string
		if json.Unmarshal(materialEncoded, &material) != nil || material == "" {
			return workspaceConfinedApplyRequest{}, fmt.Errorf("invalid materialPath")
		}
		materialPath = &material
	}
	if (selected.Kind == workspaceConfinedKindMissing) != (materialPath == nil) {
		return workspaceConfinedApplyRequest{}, fmt.Errorf("materialPath does not match selected expectation")
	}
	return workspaceConfinedApplyRequest{rootPath: rootPath, relativePath: relativePath, expectedDestination: expectedDestination,
		selectedExpectation: selected, materialPath: materialPath, recoveryDirectory: recoveryDirectory, operationID: operationID}, nil
}

func decodeWorkspaceConfinedRecoverRequest(encoded []byte) (workspaceConfinedRecoverRequest, error) {
	fields, err := decodeClosedWorkspaceConfinedObject(encoded, map[string]bool{"v": true, "rootPath": true, "recoveryDirectory": true, "operationId": true})
	if err != nil || decodeVersion(fields) != nil {
		return workspaceConfinedRecoverRequest{}, fmt.Errorf("invalid recover request")
	}
	rootPath, err := decodeRequiredString(fields, "rootPath")
	if err != nil {
		return workspaceConfinedRecoverRequest{}, err
	}
	recoveryDirectory, err := decodeRequiredString(fields, "recoveryDirectory")
	if err != nil {
		return workspaceConfinedRecoverRequest{}, err
	}
	operationID, err := decodeWorkspaceConfinedOperationID(fields)
	if err != nil {
		return workspaceConfinedRecoverRequest{}, err
	}
	return workspaceConfinedRecoverRequest{rootPath: rootPath, recoveryDirectory: recoveryDirectory, operationID: operationID}, nil
}

func decodeWorkspaceConfinedInspectRequest(encoded []byte) (workspaceConfinedInspectRequest, error) {
	fields, err := decodeClosedWorkspaceConfinedObject(encoded, map[string]bool{"v": true, "recoveryDirectory": true, "operationId": true})
	if err != nil || decodeVersion(fields) != nil {
		return workspaceConfinedInspectRequest{}, fmt.Errorf("invalid inspect request")
	}
	recoveryDirectory, err := decodeRequiredString(fields, "recoveryDirectory")
	if err != nil {
		return workspaceConfinedInspectRequest{}, err
	}
	operationID, err := decodeWorkspaceConfinedOperationID(fields)
	if err != nil {
		return workspaceConfinedInspectRequest{}, err
	}
	return workspaceConfinedInspectRequest{recoveryDirectory: recoveryDirectory, operationID: operationID}, nil
}

func decodeWorkspaceConfinedReadRequest(encoded []byte) (workspaceConfinedReadRequest, error) {
	fields, err := decodeClosedWorkspaceConfinedObject(encoded, map[string]bool{
		"v": true, "rootPath": true, "relativePath": true, "maxBytes": true, "expectedDigest": true,
	})
	if err != nil {
		return workspaceConfinedReadRequest{}, err
	}
	if err := decodeVersion(fields); err != nil {
		return workspaceConfinedReadRequest{}, err
	}
	rootPath, err := decodeRequiredString(fields, "rootPath")
	if err != nil {
		return workspaceConfinedReadRequest{}, err
	}
	relativePath, err := decodeRequiredString(fields, "relativePath")
	if err != nil {
		return workspaceConfinedReadRequest{}, err
	}
	maxEncoded, ok := fields["maxBytes"]
	if !ok {
		return workspaceConfinedReadRequest{}, fmt.Errorf("missing maxBytes")
	}
	var maxBytes int64
	if err := json.Unmarshal(maxEncoded, &maxBytes); err != nil || maxBytes < 1 || maxBytes > workspaceConfinedMaxPreviewBytes {
		return workspaceConfinedReadRequest{}, fmt.Errorf("invalid maxBytes")
	}
	expectedDigest, err := decodeOptionalDigest(fields)
	if err != nil {
		return workspaceConfinedReadRequest{}, err
	}
	return workspaceConfinedReadRequest{
		rootPath: rootPath, relativePath: relativePath, maxBytes: maxBytes, expectedDigest: expectedDigest,
	}, nil
}

func decodeWorkspaceConfinedDeleteRequest(encoded []byte) (workspaceConfinedDeleteRequest, error) {
	fields, err := decodeClosedWorkspaceConfinedObject(encoded, map[string]bool{
		"v": true, "rootPath": true, "relativePath": true, "expectedKind": true, "expectedDigest": true,
	})
	if err != nil {
		return workspaceConfinedDeleteRequest{}, err
	}
	if err := decodeVersion(fields); err != nil {
		return workspaceConfinedDeleteRequest{}, err
	}
	rootPath, err := decodeRequiredString(fields, "rootPath")
	if err != nil {
		return workspaceConfinedDeleteRequest{}, err
	}
	relativePath, err := decodeRequiredString(fields, "relativePath")
	if err != nil {
		return workspaceConfinedDeleteRequest{}, err
	}
	kindValue, err := decodeRequiredString(fields, "expectedKind")
	if err != nil {
		return workspaceConfinedDeleteRequest{}, err
	}
	kind := workspaceConfinedKind(kindValue)
	if kind != workspaceConfinedKindMissing && kind != workspaceConfinedKindFile && kind != workspaceConfinedKindDirectory && kind != workspaceConfinedKindSymlink {
		return workspaceConfinedDeleteRequest{}, fmt.Errorf("invalid expectedKind")
	}
	expectedDigest, err := decodeOptionalDigest(fields)
	if err != nil {
		return workspaceConfinedDeleteRequest{}, err
	}
	if kind == workspaceConfinedKindFile && expectedDigest == "" {
		return workspaceConfinedDeleteRequest{}, fmt.Errorf("file deletion requires expectedDigest")
	}
	if kind != workspaceConfinedKindFile && expectedDigest != "" {
		return workspaceConfinedDeleteRequest{}, fmt.Errorf("expectedDigest is valid only for files")
	}
	return workspaceConfinedDeleteRequest{
		rootPath: rootPath, relativePath: relativePath, expectedKind: kind, expectedDigest: expectedDigest,
	}, nil
}

func decodeWorkspaceConfinedDecision(encoded []byte) (string, error) {
	fields, err := decodeClosedWorkspaceConfinedObject(encoded, map[string]bool{"v": true, "decision": true})
	if err != nil {
		return "", err
	}
	if err := decodeVersion(fields); err != nil {
		return "", err
	}
	decision, err := decodeRequiredString(fields, "decision")
	if err != nil {
		return "", err
	}
	if decision != "commit" && decision != "abort" {
		return "", fmt.Errorf("invalid decision")
	}
	return decision, nil
}

func readWorkspaceConfinedLine(reader *bufio.Reader) ([]byte, error) {
	var line []byte
	for {
		fragment, more, err := reader.ReadLine()
		if err != nil {
			return nil, err
		}
		if len(line)+len(fragment) > workspaceConfinedMaxRequestBytes {
			return nil, fmt.Errorf("JSON line exceeds limit")
		}
		line = append(line, fragment...)
		if !more {
			return line, nil
		}
	}
}

func writeWorkspaceConfinedRecord(writer io.Writer, value any) error {
	encoded, err := json.Marshal(value)
	if err != nil {
		return err
	}
	_, err = writer.Write(append(encoded, '\n'))
	return err
}

func runWorkspaceConfinedExchange(
	args []string,
	input io.Reader,
	output io.Writer,
	decodeRequest func([]byte) (workspaceConfinedPreparedOperation, *workspaceConfinedDomainError),
) error {
	if len(args) != 0 {
		return fmt.Errorf("workspace-confined command accepts no arguments")
	}
	reader := bufio.NewReader(input)
	requestLine, err := readWorkspaceConfinedLine(reader)
	if err != nil {
		return fmt.Errorf("read workspace-confined request: %w", err)
	}
	operation, domainErr := decodeRequest(requestLine)
	if domainErr != nil {
		return writeWorkspaceConfinedRecord(output, domainErr.result())
	}
	defer operation.close()
	if err := writeWorkspaceConfinedRecord(output, struct {
		V int    `json:"v"`
		T string `json:"t"`
	}{V: 1, T: "workspace-confined-prepared"}); err != nil {
		return err
	}
	decisionLine, err := readWorkspaceConfinedLine(reader)
	if err == io.EOF {
		return nil
	}
	if err != nil {
		return fmt.Errorf("read workspace-confined decision: %w", err)
	}
	decision, err := decodeWorkspaceConfinedDecision(decisionLine)
	if err != nil {
		return writeWorkspaceConfinedRecord(output, workspaceConfinedError("workspace_root_unsafe", "invalid workspace confinement decision").result())
	}
	if decision == "abort" {
		return nil
	}
	return writeWorkspaceConfinedRecord(output, operation.commit())
}

func workspaceConfinedReadCommand(args []string, input io.Reader, output io.Writer) error {
	return runWorkspaceConfinedExchange(args, input, output, func(encoded []byte) (workspaceConfinedPreparedOperation, *workspaceConfinedDomainError) {
		request, err := decodeWorkspaceConfinedReadRequest(encoded)
		if err != nil {
			return nil, workspaceConfinedError("workspace_root_unsafe", "invalid workspace-confined read request")
		}
		return prepareWorkspaceConfinedRead(request)
	})
}

func workspaceConfinedDeleteCommand(args []string, input io.Reader, output io.Writer) error {
	return runWorkspaceConfinedExchange(args, input, output, func(encoded []byte) (workspaceConfinedPreparedOperation, *workspaceConfinedDomainError) {
		request, err := decodeWorkspaceConfinedDeleteRequest(encoded)
		if err != nil {
			return nil, workspaceConfinedError("workspace_root_unsafe", "invalid workspace-confined delete request")
		}
		return prepareWorkspaceConfinedDelete(request)
	})
}

func workspaceConfinedObserveCommand(args []string, input io.Reader, output io.Writer) error {
	return runWorkspaceConfinedExchange(args, input, output, func(encoded []byte) (workspaceConfinedPreparedOperation, *workspaceConfinedDomainError) {
		request, err := decodeWorkspaceConfinedObserveRequest(encoded)
		if err != nil {
			return nil, workspaceConfinedError("workspace_root_unsafe", "invalid workspace-confined observe request")
		}
		return prepareWorkspaceConfinedObserve(request)
	})
}

func workspaceConfinedCaptureCommand(args []string, input io.Reader, output io.Writer) error {
	return runWorkspaceConfinedExchange(args, input, output, func(encoded []byte) (workspaceConfinedPreparedOperation, *workspaceConfinedDomainError) {
		request, err := decodeWorkspaceConfinedCaptureRequest(encoded)
		if err != nil {
			return nil, workspaceConfinedError("workspace_root_unsafe", "invalid workspace-confined capture request")
		}
		return prepareWorkspaceConfinedCapture(request)
	})
}

func workspaceConfinedApplyCommand(args []string, input io.Reader, output io.Writer) error {
	return runWorkspaceConfinedExchange(args, input, output, func(encoded []byte) (workspaceConfinedPreparedOperation, *workspaceConfinedDomainError) {
		request, err := decodeWorkspaceConfinedApplyRequest(encoded)
		if err != nil {
			return nil, workspaceConfinedError("workspace_root_unsafe", "invalid workspace-confined apply request")
		}
		return prepareWorkspaceConfinedApply(request)
	})
}

func workspaceConfinedRecoverCommand(args []string, input io.Reader, output io.Writer) error {
	return runWorkspaceConfinedExchange(args, input, output, func(encoded []byte) (workspaceConfinedPreparedOperation, *workspaceConfinedDomainError) {
		request, err := decodeWorkspaceConfinedRecoverRequest(encoded)
		if err != nil {
			return nil, workspaceConfinedError("workspace_root_unsafe", "invalid workspace-confined recover request")
		}
		return prepareWorkspaceConfinedRecover(request)
	})
}

func workspaceConfinedInspectCommand(args []string, input io.Reader, output io.Writer) error {
	return runWorkspaceConfinedExchange(args, input, output, func(encoded []byte) (workspaceConfinedPreparedOperation, *workspaceConfinedDomainError) {
		request, err := decodeWorkspaceConfinedInspectRequest(encoded)
		if err != nil {
			return nil, workspaceConfinedError("workspace_root_unsafe", "invalid workspace-confined inspect request")
		}
		return prepareWorkspaceConfinedInspect(request)
	})
}
