import { describe, expect, it } from 'vitest';

import type { UnsupportedContentKind } from './unsupportedContentMeta';
import { resolveUnsupportedContentPresentation } from './unsupportedContentPresentation';

const AGENT_KINDS = [
    'unparsed-agent-message',
    'unsupported-agent-output',
    'unsupported-transcript-record',
] as const satisfies ReadonlyArray<UnsupportedContentKind>;

describe('resolveUnsupportedContentPresentation', () => {
    it.each(AGENT_KINDS)('keeps the raw diagnostic for %s when developer diagnostics are enabled', (kind) => {
        expect(resolveUnsupportedContentPresentation({ kind, debugInformationEnabled: true })).toBe('diagnostic');
    });

    it.each(AGENT_KINDS)('drops the %s placeholder when developer diagnostics are disabled', (kind) => {
        expect(resolveUnsupportedContentPresentation({ kind, debugInformationEnabled: false })).toBe('hidden');
    });

    it('keeps a labeled placeholder for the user own unparsed message when diagnostics are disabled', () => {
        expect(resolveUnsupportedContentPresentation({
            kind: 'unparsed-user-message',
            debugInformationEnabled: false,
        })).toBe('label');
    });

    it('keeps the raw diagnostic for the user own unparsed message when diagnostics are enabled', () => {
        expect(resolveUnsupportedContentPresentation({
            kind: 'unparsed-user-message',
            debugInformationEnabled: true,
        })).toBe('diagnostic');
    });
});
