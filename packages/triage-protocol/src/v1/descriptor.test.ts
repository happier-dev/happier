import { describe, expect, it } from 'vitest';

import {
    admitTriageSourceDescriptorV1,
    TriageSourceDescriptorV1Schema,
} from './descriptor.js';

/**
 * The one declaration a source makes about itself, and the one thing that was
 * missing from it.
 *
 * A target that lists nothing because nothing is configured has to be able to
 * send the reader somewhere. Every source already ships a Settings page for
 * exactly that, but the descriptor named no page, so the target could not
 * construct the destination and the empty screen could only describe the remedy
 * in prose. This is the field that closes that gap, and it is OPTIONAL by
 * construction: a source that declares no page is a source with no offer, never
 * a source the target refuses to admit.
 */

const MINIMAL = Object.freeze({
    v: 1,
    purpose: 'example-forge',
    displayName: 'Example Forge',
    kinds: Object.freeze([Object.freeze({
        id: 'pull-request',
        workflowSubject: 'pullRequest',
        displayName: 'Pull request',
    })]),
});

describe('the V1 source descriptor', () => {
    it('carries the source own Settings page so the target can offer a way to configure it', () => {
        const parsed = TriageSourceDescriptorV1Schema.safeParse({
            ...MINIMAL,
            settingsPageId: 'triage-sources',
        });

        expect(parsed.success).toBe(true);
        // Read back, not merely accepted: an `additive-open/drop` object drops
        // every property it does not declare, so a field that parses but does
        // not survive is exactly the state this closes.
        expect(parsed.success && parsed.data.settingsPageId).toBe('triage-sources');
    });

    it('admits a source that declares no page at all', () => {
        // Six source plugins already ship descriptors without one. A required
        // field would make every one of them inadmissible.
        const parsed = TriageSourceDescriptorV1Schema.safeParse(MINIMAL);

        expect(parsed.success).toBe(true);
        expect(parsed.success && 'settingsPageId' in parsed.data).toBe(false);
    });

    it('bounds the page it names', () => {
        expect(TriageSourceDescriptorV1Schema.safeParse({
            ...MINIMAL,
            settingsPageId: 'a'.repeat(200),
        }).success).toBe(false);
        expect(TriageSourceDescriptorV1Schema.safeParse({
            ...MINIMAL,
            settingsPageId: '',
        }).success).toBe(false);
    });

    it('rejects duplicate kind ids at the production target admission boundary', () => {
        const admitted = admitTriageSourceDescriptorV1({
            ...MINIMAL,
            kinds: [
                MINIMAL.kinds[0],
                { ...MINIMAL.kinds[0], workflowSubject: 'issue', displayName: 'Issue' },
            ],
        });

        expect(admitted).toEqual({ ok: false, reason: 'duplicateKindId' });
    });
});
