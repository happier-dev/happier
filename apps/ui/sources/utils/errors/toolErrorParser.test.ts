import { describe, it, expect } from 'vitest';
import { parseToolUseError } from './toolErrorParser';

describe('toolErrorParser', () => {
    describe('parseToolUseError', () => {
        it('reads the native execution failure reason without exposing diagnostic metadata', () => {
            const failureReason = 'environment failure: sandbox enforcement unavailable; install bwrap.\nDo not retry: the command was never started.';
            expect(parseToolUseError({ status: 'failed', failureReason, _raw: { secret: 'hidden diagnostic' } }))
                .toEqual({ isToolUseError: false, errorMessage: failureReason });
        });

        it('reads the canonical typed tool error without exposing diagnostic metadata', () => {
            const result = parseToolUseError({
                errorMessage: 'target_unavailable', errorCode: 'change_title_failed',
                _happier: { canonicalToolName: 'change_title' }, _raw: { content: 'native error' }, _acp: {},
            });
            expect(result).toEqual({ isToolUseError: false, errorMessage: 'target_unavailable' });
        });

        it('reads the persisted native title failure through the same typed-error contract', () => {
            const content = '{"errorCode":"change_title_failed","error":"target_unavailable"}';
            expect(parseToolUseError({ content, tool_use_result: `Error: ${content}`, title: 'errorCode' }))
                .toEqual({ isToolUseError: false, errorMessage: 'target_unavailable' });
        });

        it('should parse tool use error correctly', () => {
            const input = '<tool_use_error>File has not been read yet. Read it first before writing to it.</tool_use_error>';
            const result = parseToolUseError(input);
            
            expect(result.isToolUseError).toBe(true);
            expect(result.errorMessage).toBe('File has not been read yet. Read it first before writing to it.');
        });

        it('should handle normal error messages', () => {
            const input = 'This is a regular error message';
            const result = parseToolUseError(input);
            
            expect(result.isToolUseError).toBe(false);
            expect(result.errorMessage).toBe(null);
        });

        it('should handle empty tool use error tags', () => {
            const input = '<tool_use_error></tool_use_error>';
            const result = parseToolUseError(input);
            
            expect(result.isToolUseError).toBe(true);
            expect(result.errorMessage).toBe('');
        });

        it('should handle multiline content', () => {
            const input = '<tool_use_error>Error:\nLine 1\nLine 2</tool_use_error>';
            const result = parseToolUseError(input);
            
            expect(result.isToolUseError).toBe(true);
            expect(result.errorMessage).toBe('Error:\nLine 1\nLine 2');
        });

        it('should handle non-string input', () => {
            const result = parseToolUseError(null as any);
            
            expect(result.isToolUseError).toBe(false);
            expect(result.errorMessage).toBe(null);
        });

        it('should ignore partial or malformed tags', () => {
            expect(parseToolUseError('<tool_use_error>oops')).toEqual({
                isToolUseError: false,
                errorMessage: null,
            });
            expect(parseToolUseError('</tool_use_error>oops')).toEqual({
                isToolUseError: false,
                errorMessage: null,
            });
        });
    });
});
