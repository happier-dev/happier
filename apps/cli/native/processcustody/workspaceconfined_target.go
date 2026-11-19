package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"regexp"
)

// Workspace operations for a Session's execution target (container/sandbox),
// run by the per-Session holder inside the target. Each command reads one JSON
// request line and answers one JSON result line; confinement is the same handle
// chain as read/delete/observe/capture (Linux only: targets are Linux guests).
//
// workspace-confined-meta  {v, rootPath, relativePath ("" = root), op}
//   op lstat    -> {status:"entry", entry}
//   op stat     -> {status:"entry", entry, path}   (links followed inside the root)
//   op list     -> {status:"entries", entries:[{name, kind}]}
//   op readlink -> {status:"link", target}
//   op realpath -> {status:"path", path}           (root-relative, "" = root)
//   missing     -> {status:"missing"}
// workspace-confined-write {v, rootPath, op, relativePath, ...} [+ sizeBytes raw bytes for put]
//   op put    {sizeBytes, mode, expect:"absent"|"any"|<sha256>} -> {status:"written", sha256}
//                                                  | {status:"exists"} | {status:"changed", sha256}
//   op mkdir  {recursive} -> {status:"done"}
//   op rename {toRelativePath} -> {status:"done"}
//   op rmdir -> {status:"done"} | error not_empty (never removes contents)
// Errors: {status:"error", code, message} with code workspace_root_unsafe,
// workspace_file_unsupported, not_directory, not_link, symlink_loop, io_failed.

type workspaceTargetEntry struct {
	Kind    string  `json:"kind"`
	Size    uint64  `json:"size"`
	AtimeMs float64 `json:"atimeMs"`
	MtimeMs float64 `json:"mtimeMs"`
	CtimeMs float64 `json:"ctimeMs"`
	Mode    uint32  `json:"mode"`
	Dev     uint64  `json:"dev"`
	Ino     uint64  `json:"ino"`
}

type workspaceTargetListEntry struct {
	Name string `json:"name"`
	Kind string `json:"kind"`
}

type workspaceTargetResult struct {
	V       int                        `json:"v"`
	T       string                     `json:"t"`
	Status  string                     `json:"status"`
	Entry   *workspaceTargetEntry      `json:"entry,omitempty"`
	Entries []workspaceTargetListEntry `json:"entries,omitempty"`
	Target  *string                    `json:"target,omitempty"`
	Path    *string                    `json:"path,omitempty"`
	Sha256  string                     `json:"sha256,omitempty"`
	Code    string                     `json:"code,omitempty"`
	Message string                     `json:"message,omitempty"`
}

func workspaceTargetError(code, message string) workspaceTargetResult {
	return workspaceTargetResult{V: 1, T: "workspace-target-result", Status: "error", Code: code, Message: message}
}

func workspaceTargetStatus(status string) workspaceTargetResult {
	return workspaceTargetResult{V: 1, T: "workspace-target-result", Status: status}
}

type workspaceTargetMetaRequest struct {
	rootPath     string
	relativePath string
	op           string
}

type workspaceTargetWriteRequest struct {
	rootPath       string
	relativePath   string
	op             string
	toRelativePath string
	sizeBytes      int64
	mode           uint32
	expect         string
	recursive      bool
	atimeMs        int64
	mtimeMs        int64
}

var workspaceTargetSha256Pattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

func decodeWorkspaceTargetMetaRequest(encoded []byte) (workspaceTargetMetaRequest, error) {
	fields, err := decodeClosedWorkspaceConfinedObject(encoded, map[string]bool{"v": true, "rootPath": true, "relativePath": true, "op": true})
	if err != nil {
		return workspaceTargetMetaRequest{}, err
	}
	if err := decodeVersion(fields); err != nil {
		return workspaceTargetMetaRequest{}, err
	}
	request := workspaceTargetMetaRequest{}
	if request.rootPath, err = decodeRequiredString(fields, "rootPath"); err != nil {
		return request, err
	}
	if request.relativePath, err = decodeRequiredString(fields, "relativePath"); err != nil {
		return request, err
	}
	if request.op, err = decodeRequiredString(fields, "op"); err != nil {
		return request, err
	}
	switch request.op {
	case "lstat", "stat", "list", "readlink", "realpath", "access-executable":
		return request, nil
	}
	return request, fmt.Errorf("unknown op")
}

func decodeWorkspaceTargetWriteRequest(encoded []byte) (workspaceTargetWriteRequest, error) {
	fields, err := decodeClosedWorkspaceConfinedObject(encoded, map[string]bool{"v": true, "rootPath": true, "relativePath": true, "op": true,
		"toRelativePath": true, "sizeBytes": true, "mode": true, "expect": true, "recursive": true, "atimeMs": true, "mtimeMs": true})
	if err != nil {
		return workspaceTargetWriteRequest{}, err
	}
	if err := decodeVersion(fields); err != nil {
		return workspaceTargetWriteRequest{}, err
	}
	request := workspaceTargetWriteRequest{mode: 0o644}
	if request.rootPath, err = decodeRequiredString(fields, "rootPath"); err != nil {
		return request, err
	}
	if request.relativePath, err = decodeRequiredString(fields, "relativePath"); err != nil {
		return request, err
	}
	if request.op, err = decodeRequiredString(fields, "op"); err != nil {
		return request, err
	}
	if raw, ok := fields["mode"]; ok {
		if err := json.Unmarshal(raw, &request.mode); err != nil || request.mode > 0o777 {
			return request, fmt.Errorf("invalid mode")
		}
	}
	switch request.op {
	case "put":
		raw, ok := fields["sizeBytes"]
		if !ok || json.Unmarshal(raw, &request.sizeBytes) != nil || request.sizeBytes < 0 || uint64(request.sizeBytes) > workspaceConfinedMaxSafeJSONInteger {
			return request, fmt.Errorf("invalid sizeBytes")
		}
		if request.expect, err = decodeRequiredString(fields, "expect"); err != nil {
			return request, err
		}
		if request.expect != "absent" && request.expect != "any" && !workspaceTargetSha256Pattern.MatchString(request.expect) {
			return request, fmt.Errorf("invalid expect")
		}
	case "mkdir":
		if raw, ok := fields["recursive"]; ok && json.Unmarshal(raw, &request.recursive) != nil {
			return request, fmt.Errorf("invalid recursive")
		}
	case "rename", "copy-exclusive":
		if request.toRelativePath, err = decodeRequiredString(fields, "toRelativePath"); err != nil {
			return request, err
		}
	case "set-times":
		if json.Unmarshal(fields["atimeMs"], &request.atimeMs) != nil || json.Unmarshal(fields["mtimeMs"], &request.mtimeMs) != nil {
			return request, fmt.Errorf("invalid timestamps")
		}
	case "rmdir", "open-exclusive":
	default:
		return request, fmt.Errorf("unknown op")
	}
	return request, nil
}

func workspaceConfinedMetaCommand(args []string, input io.Reader, output io.Writer) error {
	if len(args) != 0 {
		return fmt.Errorf("workspace-confined-meta accepts no arguments")
	}
	line, err := readWorkspaceConfinedLine(bufio.NewReader(input))
	if err != nil {
		return fmt.Errorf("read workspace-confined-meta request: %w", err)
	}
	request, err := decodeWorkspaceTargetMetaRequest(line)
	if err != nil {
		return writeWorkspaceConfinedRecord(output, workspaceTargetError("workspace_root_unsafe", "invalid workspace-confined-meta request"))
	}
	return writeWorkspaceConfinedRecord(output, runWorkspaceTargetMeta(request))
}

func workspaceConfinedWriteCommand(args []string, input io.Reader, output io.Writer) error {
	if len(args) != 0 {
		return fmt.Errorf("workspace-confined-write accepts no arguments")
	}
	reader := bufio.NewReader(input)
	line, err := readWorkspaceConfinedLine(reader)
	if err != nil {
		return fmt.Errorf("read workspace-confined-write request: %w", err)
	}
	request, err := decodeWorkspaceTargetWriteRequest(line)
	if err != nil {
		return writeWorkspaceConfinedRecord(output, workspaceTargetError("workspace_root_unsafe", "invalid workspace-confined-write request"))
	}
	if request.op == "open-exclusive" {
		return openExclusiveWorkspaceTargetFile(request, reader, output)
	}
	var content []byte
	if request.op == "put" {
		content = make([]byte, request.sizeBytes)
		if _, err := io.ReadFull(reader, content); err != nil {
			return writeWorkspaceConfinedRecord(output, workspaceTargetError("io_failed", "content ended before sizeBytes"))
		}
	}
	return writeWorkspaceConfinedRecord(output, runWorkspaceTargetWrite(request, content))
}
