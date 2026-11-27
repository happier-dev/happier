package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"strings"
)

const (
	serveMaxHeaderBytes          = 8 * 1024 * 1024
	serveMaxBodyBytes            = 128 * 1024 * 1024
	serveMaxConcurrency          = 16
	serveMaxStreamPipeBytes      = 32 * 1024 * 1024
	serveMaxTotalStreamPipeBytes = 64 * 1024 * 1024
)

type serveFrameHeader struct {
	V                      int             `json:"v"`
	ID                     string          `json:"id"`
	Op                     string          `json:"op"`
	BodyBytes              int64           `json:"bodyBytes,omitempty"`
	RequireAuthorityCommit bool            `json:"requireAuthorityCommit,omitempty"`
	StreamMaterial         bool            `json:"streamMaterial,omitempty"`
	RelativePath           string          `json:"relativePath,omitempty"`
	ToRelativePath         string          `json:"toRelativePath,omitempty"`
	Paths                  []string        `json:"paths,omitempty"`
	FollowSymlinks         *bool           `json:"followSymlinks,omitempty"`
	MaxTotalInlineBytes    *uint64         `json:"maxTotalInlineBytes,omitempty"`
	MaxBytes               *uint64         `json:"maxBytes,omitempty"`
	Mode                   *uint32         `json:"mode,omitempty"`
	Expect                 string          `json:"expect,omitempty"`
	Recursive              bool            `json:"recursive,omitempty"`
	AtimeMs                *int64          `json:"atimeMs,omitempty"`
	MtimeMs                *int64          `json:"mtimeMs,omitempty"`
	Request                json.RawMessage `json:"request,omitempty"`
}

type serveResponseFrame struct {
	V         int                     `json:"v"`
	ID        string                  `json:"id,omitempty"`
	T         string                  `json:"t"`
	BodyBytes int64                   `json:"bodyBytes,omitempty"`
	Result    any                     `json:"result,omitempty"`
	Results   []workspaceTargetResult `json:"results,omitempty"`
	Code      string                  `json:"code,omitempty"`
	Message   string                  `json:"message,omitempty"`
}

func parseWorkspaceConfinedServeArgs(args []string) (string, error) {
	if len(args) == 1 && strings.HasPrefix(args[0], "--root=") {
		rootPath := strings.TrimPrefix(args[0], "--root=")
		if rootPath == "" {
			return "", fmt.Errorf("workspace-confined-serve requires a non-empty --root path")
		}
		return rootPath, nil
	}
	if len(args) == 2 && args[0] == "--root" && args[1] != "" {
		return args[1], nil
	}
	return "", fmt.Errorf("usage: workspace-confined-serve --root <canonicalRoot>")
}

func workspaceConfinedServeCommand(args []string, input io.Reader, output io.Writer) error {
	rootPath, err := parseWorkspaceConfinedServeArgs(args)
	if err != nil {
		return err
	}
	return runWorkspaceConfinedServe(rootPath, input, output)
}

func readServeHeaderLine(reader *bufio.Reader) ([]byte, error) {
	var line []byte
	for {
		fragment, more, err := reader.ReadLine()
		if err != nil {
			return nil, err
		}
		if len(line)+len(fragment) > serveMaxHeaderBytes {
			return nil, fmt.Errorf("serve header line exceeds limit")
		}
		line = append(line, fragment...)
		if !more {
			return line, nil
		}
	}
}
