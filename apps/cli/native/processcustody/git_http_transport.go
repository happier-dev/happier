package main

import (
	"bufio"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"sync"
)

// Git sees only this credential-free endpoint. Authentication is applied by the
// controller after requests cross the existing holder's binary stdio stream.
func gitHTTPTransportCommand(args []string, input io.Reader, output io.Writer) error {
	if len(args) != 0 {
		return errors.New("git-http-transport takes no arguments")
	}
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return err
	}
	defer listener.Close()
	if err = json.NewEncoder(output).Encode(map[string]any{"v": 1, "url": "http://" + listener.Addr().String() + "/"}); err != nil {
		return err
	}
	reader := bufio.NewReader(input)
	type responseHead struct {
		Status  int         `json:"status"`
		Headers http.Header `json:"headers"`
	}
	responses := make(chan responseHead)
	consumed := make(chan struct{})
	closed := make(chan struct{})
	var exchange sync.Mutex
	server := &http.Server{Handler: http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		exchange.Lock()
		defer exchange.Unlock()
		defer request.Body.Close()
		head := map[string]any{"method": request.Method, "path": request.URL.RequestURI(), "headers": request.Header}
		if err := json.NewEncoder(output).Encode(head); err != nil {
			return
		}
		if _, err := io.Copy(gitHTTPChunkWriter{output}, request.Body); err != nil {
			return
		}
		if err := binary.Write(output, binary.BigEndian, uint32(0)); err != nil {
			return
		}
		var response responseHead
		select {
		case response = <-responses:
		case <-closed:
			return
		}
		for name, values := range response.Headers {
			for _, value := range values {
				writer.Header().Add(name, value)
			}
		}
		writer.WriteHeader(response.Status)
		io.Copy(writer, &gitHTTPChunkReader{reader: reader})
		select {
		case consumed <- struct{}{}:
		case <-closed:
		}
	})}
	go server.Serve(listener)
	defer server.Close()
	defer close(closed)
	for {
		line, err := reader.ReadBytes('\n')
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		var response responseHead
		if err := json.Unmarshal(line, &response); err != nil {
			return err
		}
		if response.Status < 100 || response.Status > 599 {
			return errors.New("invalid Git HTTP status")
		}
		responses <- response
		<-consumed
	}
}

type gitHTTPChunkWriter struct{ writer io.Writer }

func (writer gitHTTPChunkWriter) Write(bytes []byte) (int, error) {
	if len(bytes) == 0 {
		return 0, nil
	}
	if err := binary.Write(writer.writer, binary.BigEndian, uint32(len(bytes))); err != nil {
		return 0, err
	}
	return writer.writer.Write(bytes)
}

type gitHTTPChunkReader struct {
	reader    io.Reader
	remaining uint32
	done      bool
}

func (reader *gitHTTPChunkReader) Read(bytes []byte) (int, error) {
	if len(bytes) == 0 {
		return 0, nil
	}
	if reader.done {
		return 0, io.EOF
	}
	if reader.remaining == 0 {
		if err := binary.Read(reader.reader, binary.BigEndian, &reader.remaining); err != nil {
			return 0, err
		}
		if reader.remaining == 0 {
			reader.done = true
			return 0, io.EOF
		}
	}
	if uint32(len(bytes)) > reader.remaining {
		bytes = bytes[:reader.remaining]
	}
	n, err := reader.reader.Read(bytes)
	reader.remaining -= uint32(n)
	return n, err
}
