package managedruntime

import (
	"cmp"
	"encoding/json"
	"maps"
	"slices"
	"strconv"
	"strings"
)

type wireArgumentNumbers struct {
	Event       string            `json:"event"`
	OutputIndex int               `json:"outputIndex"`
	Numbers     []wireNumberShape `json:"numbers"`
}

type wireNumberShape struct {
	Path  string `json:"path"`
	Class string `json:"class"`
}

func (f *wireFrames) projectResponseArguments(frame wireFrame) {
	// The HTTP JSON response carries output directly, without an SSE type.
	if !f.sse && frame.Type == "" && frame.Output != nil {
		frame.Type = "response"
	}
	switch frame.Type {
	case "response.function_call_arguments.delta":
		var delta string
		if json.Unmarshal(frame.Delta, &delta) != nil {
			f.incomplete = true
			return
		}
		if delta != "" {
			f.appendArgumentDelta(frame.OutputIndex, delta)
		}
	case "response.function_call_arguments.done":
		f.finishArgumentDelta(frame.OutputIndex)
		f.projectArgumentString(frame.Type, frame.OutputIndex, frame.Arguments)
	case "response.output_item.added", "response.output_item.done":
		if frame.Item.Type == "function_call" {
			if frame.Type == "response.output_item.done" {
				f.finishArgumentDelta(frame.OutputIndex)
			}
			f.projectArgumentString(frame.Type, frame.OutputIndex, frame.Item.Arguments)
		}
	case "response.completed", "response.incomplete", "response.failed", "response":
		f.finishArgumentDeltas()
		output := frame.Response.Output
		if frame.Type == "response" {
			output = frame.Output
		}
		for index, item := range output {
			if item.Type == "function_call" {
				f.projectArgumentString(frame.Type, index, item.Arguments)
			}
		}
	}
}

func (f *wireFrames) appendArgumentDelta(index int, delta string) {
	if f.argumentDeltas == nil {
		f.argumentDeltas = make(map[int][]byte)
	}
	pending, exists := f.argumentDeltas[index]
	if exists && pending == nil {
		return // An oversized value was already skipped.
	}
	// A fragmented argument represents the same logical value as the full
	// argument in a completion frame. Reuse the diagnostic frame budget.
	if len(delta) > wireFrameLimit-len(pending) {
		f.argumentDeltas[index] = nil
		f.incomplete = true
		return
	}
	f.argumentDeltas[index] = append(pending, delta...)
}

func (f *wireFrames) finishArgumentDelta(index int) {
	if pending, ok := f.argumentDeltas[index]; ok {
		delete(f.argumentDeltas, index)
		f.projectArgumentNumbers("response.function_call_arguments.delta", index, string(pending))
	}
}

func (f *wireFrames) finishArgumentDeltas() {
	for _, index := range slices.Sorted(maps.Keys(f.argumentDeltas)) {
		f.finishArgumentDelta(index)
	}
}

func (f *wireFrames) projectArgumentString(event string, index int, raw json.RawMessage) {
	if len(raw) == 0 {
		return
	}
	var arguments string
	if json.Unmarshal(raw, &arguments) != nil {
		f.incomplete = true
		return
	}
	f.projectArgumentNumbers(event, index, arguments)
}

func (f *wireFrames) projectArgumentNumbers(event string, index int, arguments string) {
	if arguments == "" {
		return
	}
	decoder := json.NewDecoder(strings.NewReader(arguments))
	decoder.UseNumber()
	var value any
	if decoder.Decode(&value) != nil || strings.Trim(arguments[decoder.InputOffset():], " \t\r\n") != "" {
		f.incomplete = true
		return
	}
	numbers := []wireNumberShape{}
	collectWireNumbers(value, "", &numbers)
	slices.SortFunc(numbers, func(a, b wireNumberShape) int { return cmp.Compare(a.Path, b.Path) })
	f.stream.ArgumentNumbers = append(f.stream.ArgumentNumbers, wireArgumentNumbers{Event: event, OutputIndex: index, Numbers: numbers})
}

var wireJSONPointerEscape = strings.NewReplacer("~", "~0", "/", "~1")

func collectWireNumbers(value any, path string, numbers *[]wireNumberShape) {
	switch value := value.(type) {
	case json.Number:
		class := "integer"
		if strings.ContainsRune(value.String(), '.') {
			class = "decimal-with-fraction"
		} else if strings.ContainsAny(value.String(), "eE") {
			class = "exponent"
		}
		*numbers = append(*numbers, wireNumberShape{Path: path, Class: class})
	case map[string]any:
		for key, child := range value {
			collectWireNumbers(child, path+"/"+wireJSONPointerEscape.Replace(key), numbers)
		}
	case []any:
		for index, child := range value {
			collectWireNumbers(child, path+"/"+strconv.Itoa(index), numbers)
		}
	}
}
