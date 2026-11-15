package managedruntime

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"strings"
)

// Meta's subscription refusal uses the same code as a transient throttle. Give
// OpenAI-compatible clients a terminal quota code without changing its reset or
// Retry-After. Other failures retain their original wire representation.
func normalizeMetaQuotaResponse(response *http.Response) error {
	if response.StatusCode != http.StatusTooManyRequests || response.Body == nil {
		return nil
	}
	body, err := io.ReadAll(response.Body)
	_ = response.Body.Close()
	if err != nil {
		return err
	}
	var envelope map[string]json.RawMessage
	var failure map[string]json.RawMessage
	var code, errorType, message string
	var reset int64
	if json.Unmarshal(body, &envelope) == nil && json.Unmarshal(envelope["error"], &failure) == nil {
		_ = json.Unmarshal(failure["code"], &code)
		_ = json.Unmarshal(failure["type"], &errorType)
		_ = json.Unmarshal(failure["message"], &message)
		_ = json.Unmarshal(failure["resets_at"], &reset)
		message = strings.ToLower(message)
		if code == "rate_limit_exceeded" && errorType == "rate_limit_error" && reset > 0 &&
			(strings.Contains(message, "subscription quota") || strings.Contains(message, "quota exhausted")) {
			failure["code"] = json.RawMessage(`"insufficient_quota"`)
			errorBody, errMarshal := json.Marshal(failure)
			if errMarshal != nil {
				return errMarshal
			}
			envelope["error"] = errorBody
			body, err = json.Marshal(envelope)
			if err != nil {
				return err
			}
			response.ContentLength = int64(len(body))
			response.Header.Set("Content-Length", strconv.Itoa(len(body)))
		}
	}
	response.Body = io.NopCloser(bytes.NewReader(body))
	return nil
}
