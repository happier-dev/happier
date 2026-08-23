import { describe, expect, it } from 'vitest';
import {
    defineProtocolLiteral,
    defineProtocolObject,
    defineProtocolArray,
    defineProtocolUnion,
} from '@happier-dev/plugin-sdk/protocol';
import { TriageScanContinuationV1Schema, MAX_TRIAGE_PAGING_TOKEN_UTF8_BYTES_V1 } from '@happier-dev/triage-protocol/v1';
import { buildMaximalSchemaValue, encodedJsonBytes } from '@happier-dev/triage-protocol/testing/v1';
import { TriageListEntriesResultV1Schema, TriageListEntriesInputV1Schema } from './listEntriesProtocol.js';

describe('scratch', () => {
    it('measures', () => {
        const base = encodedJsonBytes(buildMaximalSchemaValue(TriageListEntriesResultV1Schema.jsonSchema, 'r'));
        const baseIn = encodedJsonBytes(buildMaximalSchemaValue(TriageListEntriesInputV1Schema.jsonSchema, 'i'));
        const oneContinuation = encodedJsonBytes(buildMaximalSchemaValue(TriageScanContinuationV1Schema.jsonSchema, 'c'));
        // eslint-disable-next-line no-console
        console.log(JSON.stringify({ base, baseIn, oneContinuation, token: MAX_TRIAGE_PAGING_TOKEN_UTF8_BYTES_V1, gate: 1024*1024 }));
        expect(base).toBeGreaterThan(0);
        void defineProtocolLiteral; void defineProtocolObject; void defineProtocolArray; void defineProtocolUnion;
    });
});
