package main

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"encoding/json"
	"io"
	"net/http"
	"testing"
)

func TestGitHTTPTransportStreamsBinaryWithoutCredentialsAndClosesAtEOF(t *testing.T) {
	input, host := io.Pipe()
	controller, output := io.Pipe()
	done := make(chan error, 1)
	go func() { done <- gitHTTPTransportCommand(nil, input, output); output.Close() }()
	reader := bufio.NewReader(controller)
	line, err := reader.ReadBytes('\n')
	if err != nil {
		t.Fatal(err)
	}
	var hello struct {
		URL string `json:"url"`
	}
	if err = json.Unmarshal(line, &hello); err != nil {
		t.Fatal(err)
	}
	payload := []byte{0, 255, 10, 13, 42}
	response := make(chan []byte, 1)
	go func() {
		result, err := http.Post(hello.URL+"git-upload-pack", "application/x-git-upload-pack-request", bytes.NewReader(payload))
		if err != nil {
			response <- nil
			return
		}
		defer result.Body.Close()
		body, _ := io.ReadAll(result.Body)
		response <- body
	}()
	line, err = reader.ReadBytes('\n')
	if err != nil {
		t.Fatal(err)
	}
	var request struct{ Method, Path string }
	if err = json.Unmarshal(line, &request); err != nil {
		t.Fatal(err)
	}
	if request.Method != "POST" || request.Path != "/git-upload-pack" {
		t.Fatalf("unexpected request: %s", line)
	}
	var received []byte
	for {
		var length uint32
		if err = binary.Read(reader, binary.BigEndian, &length); err != nil {
			t.Fatal(err)
		}
		if length == 0 {
			break
		}
		chunk := make([]byte, length)
		if _, err = io.ReadFull(reader, chunk); err != nil {
			t.Fatal(err)
		}
		received = append(received, chunk...)
	}
	if !bytes.Equal(received, payload) {
		t.Fatalf("request bytes: %v", received)
	}
	io.WriteString(host, "{\"status\":200,\"headers\":{\"Content-Type\":[\"application/x-git-upload-pack-result\"]}}\n")
	binary.Write(host, binary.BigEndian, uint32(len(payload)))
	host.Write(payload)
	binary.Write(host, binary.BigEndian, uint32(0))
	if got := <-response; !bytes.Equal(got, payload) {
		t.Fatalf("response bytes: %v", got)
	}
	host.Close()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}
