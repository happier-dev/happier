package managedruntime

import (
	"bufio"
	"io"
	"strings"
	"testing"
)

func TestIntegerArgumentStreamPreservesInterleavedFrames(t *testing.T) {
	const added = "event: response.output_item.added\r\n" +
		"data: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"type\":\"function_call\",\"name\":\"poll\"}}\r\n\r\n"
	const first = `data: {"type":"response.function_call_arguments.delta", "output_index":0, "delta":"{\"count\":9"}` + "\n\n"
	const unrelated = `data: {"type":"response.function_call_arguments.delta", "output_index":1, "delta":"{\"count\":30000.0}", "text":"\u003e"}` + "\n\n"
	const second = `data: {"type":"response.function_call_arguments.delta", "output_index":0, "delta":"007199254740993.0,\"exponent\":3.0e4,\"string\":\"30000.0\",\"overflow\":18446744073709551616.0}"}` + "\n\n"
	const secondNormalized = `data: {"type":"response.function_call_arguments.delta", "output_index":0, "delta":"007199254740993,\"exponent\":30000,\"string\":\"30000.0\",\"overflow\":18446744073709551616.0}"}` + "\n\n"
	const done = `data: {"type":"response.function_call_arguments.done", "output_index":0}` + "\n\n"
	body := io.NopCloser(strings.NewReader(added + first + unrelated + second + done))
	stream := &integerArgumentStream{
		ReadCloser: body,
		source:     bufio.NewReader(body),
		schemas:    integerToolSchemas{"poll": {"count": true, "exponent": true, "string": true, "overflow": true}},
		calls:      make(map[int]*streamedIntegerArguments),
	}
	got, err := io.ReadAll(stream)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != added+first+unrelated+secondNormalized+done {
		t.Fatal("Responses codec changed frame order or unrelated bytes, or failed to normalize exact integer tokens")
	}
}
