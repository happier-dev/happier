import { describe, expect, it } from 'vitest';

import {
    PLUGIN_DECLARATIVE_DOCUMENT_CONTENT_TYPE_V1 as canonicalContentType,
} from '@happier-dev/protocol/plugins/contributions/ui/declarative-document-authoring';
import {
    definePluginDeclarativeDocumentV1,
    PLUGIN_DECLARATIVE_DOCUMENT_CONTENT_TYPE_V1,
    type PluginDeclarativeDocumentV1,
} from '../ui.js';
import * as publicUi from './index.js';

describe('declarative document author projection', () => {
    it('projects the canonical document facade through the public UI subpath', () => {
        expect(publicUi.definePluginDeclarativeDocumentV1)
            .toBe(definePluginDeclarativeDocumentV1);
        expect(publicUi.PLUGIN_DECLARATIVE_DOCUMENT_CONTENT_TYPE_V1)
            .toBe(PLUGIN_DECLARATIVE_DOCUMENT_CONTENT_TYPE_V1);
    });

    it('uses the canonical content type and strict document grammar', () => {
        const document = definePluginDeclarativeDocumentV1({
            version: 1,
            root: {
                kind: 'stack',
                children: [{ kind: 'text', text: 'Review status' }],
            },
        });

        expect(PLUGIN_DECLARATIVE_DOCUMENT_CONTENT_TYPE_V1).toBe(canonicalContentType);
        expect(document).toEqual({
            version: 1,
            root: {
                kind: 'stack',
                children: [{ kind: 'text', text: 'Review status' }],
            },
        } satisfies PluginDeclarativeDocumentV1);
    });

    it('accepts only the closed composerApply effect through the canonical Protocol grammar', () => {
        const document = definePluginDeclarativeDocumentV1({
            version: 1,
            root: {
                kind: 'action',
                label: 'Replace draft',
                effect: {
                    kind: 'composerApply',
                    expectedRevision: 4,
                    operations: [{ kind: 'text.set', text: 'Triage this incident' }],
                },
            },
        });

        expect(document.root).toMatchObject({
            kind: 'action',
            effect: {
                kind: 'composerApply',
                expectedRevision: 4,
                operations: [{ kind: 'text.set', text: 'Triage this incident' }],
            },
        });

        expect(() => definePluginDeclarativeDocumentV1({
            version: 1,
            root: {
                kind: 'action',
                label: 'Forged target',
                effect: {
                    kind: 'composerApply',
                    expectedRevision: 4,
                    operations: [{ kind: 'text.clear' }],
                    ref: { kind: 'session', sessionId: 'session-forged' },
                },
            },
        } as unknown as PluginDeclarativeDocumentV1)).toThrow(/unrecognized key/iu);
    });

    it('rejects unknown document fields before a dynamic Resource produces bytes', () => {
        expect(() => definePluginDeclarativeDocumentV1({
            version: 1,
            root: {
                kind: 'text',
                text: 'Review status',
                unexpected: true,
            },
        } as unknown as PluginDeclarativeDocumentV1)).toThrow(/unrecognized key/iu);
    });
});
