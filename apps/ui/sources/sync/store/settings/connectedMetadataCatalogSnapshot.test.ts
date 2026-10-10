import { describe, expect, it } from 'vitest';
import type { ConnectedMetadataCatalogV1 } from '@happier-dev/protocol/connect/connectedMetadataCatalogV1';
import { connectedAcknowledgementSubjectKeyV1, connectedEntitySubjectKeyV1 } from '@happier-dev/protocol/connect/connectedAccountPresentationRowsV1';
import { connectedServiceProfileKey } from '@happier-dev/protocol/connect/connectedServiceProfilePreferences';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contributionIdentity';
import { applyConnectedMetadataCatalogSnapshot, beginConnectedMetadataCatalogLoad, getConnectedMetadataCatalog,
    subscribeConnectedMetadataCatalog } from './connectedMetadataCatalogSnapshot';

const service = { pluginId: 'custom.safe-profile', localId: 'compute' };
const account = { service, accountId: 'opaque:account' };
const labelKey = connectedServiceProfileKey({ serviceId: buildQualifiedPluginContributionKey(service), profileId: account.accountId });
const groupLabelKey = connectedEntitySubjectKeyV1({ kind: 'group', service, groupId: 'primary' });
const acknowledgement = { kind: 'warning' as const, warningId: 'test-warning', scope: { kind: 'account' as const } };
const acknowledgementKey = connectedAcknowledgementSubjectKeyV1(acknowledgement);
const ready: ConnectedMetadataCatalogV1 = {
    presentation: { status: 'ready', entries: [{ v: 1, subject: { kind: 'account', account }, label: 'Current label' },
        { v: 1, subject: { kind: 'group', service, groupId: 'primary' }, label: 'Pool label' }], revision: 3, diagnostics: [] },
    acknowledgements: { status: 'ready', entries: [{ v: 1, subject: acknowledgement, acknowledged: true }], revision: 4, diagnostics: [] },
    disclosure: [],
};

describe('Connected metadata catalog publication', () => {
    it('publishes qualified labels and acknowledgements only to the addressed Account, retaining unchanged identities', () => {
        const scope = { serverId: 'metadata-home', accountId: 'metadata-owner' };
        const other = { ...scope, accountId: 'another-owner' };
        let notifications = 0;
        const unsubscribe = subscribeConnectedMetadataCatalog(() => { notifications += 1; });
        try {
            applyConnectedMetadataCatalogSnapshot(scope, ready, true);
            const first = getConnectedMetadataCatalog(scope);
            expect(first.labelsByKey).toEqual({ [labelKey]: 'Current label', [groupLabelKey]: 'Pool label' });
            expect(first.acknowledgementsByKey).toEqual({ [acknowledgementKey]: true });
            expect(getConnectedMetadataCatalog(other).labelsByKey).toEqual({});
            applyConnectedMetadataCatalogSnapshot(scope, structuredClone(ready), true);
            expect(getConnectedMetadataCatalog(scope)).toBe(first);
            expect(notifications).toBe(1);
            applyConnectedMetadataCatalogSnapshot(scope, { ...ready,
                acknowledgements: { status: 'ready', entries: [], revision: 5, diagnostics: [] } }, true);
            expect(getConnectedMetadataCatalog(scope).labelsByKey).toBe(first.labelsByKey);
            expect(getConnectedMetadataCatalog(scope).acknowledgementsByKey).toEqual({});
        } finally { unsubscribe(); }
    });

    it('keeps last-known display during transport refresh but withdraws private content after admission loss', () => {
        const scope = { serverId: 'refresh-home', accountId: 'refresh-owner' };
        applyConnectedMetadataCatalogSnapshot(scope, ready, true);
        const first = getConnectedMetadataCatalog(scope);
        beginConnectedMetadataCatalogLoad(scope);
        expect(getConnectedMetadataCatalog(scope)).toMatchObject({ presentation: { status: 'loading' },
            labelsByKey: first.labelsByKey, acknowledgementsByKey: first.acknowledgementsByKey,
            presentationStale: true, acknowledgementsStale: true });
        applyConnectedMetadataCatalogSnapshot(scope, { presentation: { status: 'unavailable', reason: 'unreachable' },
            acknowledgements: { status: 'unavailable', reason: 'unreachable' }, disclosure: [] }, true);
        expect(getConnectedMetadataCatalog(scope).labelsByKey).toBe(first.labelsByKey);
        applyConnectedMetadataCatalogSnapshot(scope, ready, false);
        expect(getConnectedMetadataCatalog(scope).presentation.status).toBe('unavailable');
        applyConnectedMetadataCatalogSnapshot(scope, { presentation: { status: 'unavailable', reason: 'account-mode-mismatch' },
            acknowledgements: { status: 'unavailable', reason: 'unauthorized' }, disclosure: [] }, true);
        expect(getConnectedMetadataCatalog(scope)).toMatchObject({ labelsByKey: {}, acknowledgementsByKey: {} });
    });

    it('publishes usable partial entries without reviving removed or invalid prior entries', () => {
        const scope = { serverId: 'partial-home', accountId: 'partial-owner' };
        applyConnectedMetadataCatalogSnapshot(scope, ready, true);
        applyConnectedMetadataCatalogSnapshot(scope, { presentation: { status: 'partial', entries: [], revision: 6,
            diagnostics: [{ root: 'presentation', reason: 'invalid-entry' }] },
            acknowledgements: { status: 'ready', entries: [], revision: 7, diagnostics: [] }, disclosure: [] }, true);
        expect(getConnectedMetadataCatalog(scope)).toMatchObject({ labelsByKey: {}, acknowledgementsByKey: {},
            presentation: { status: 'partial' }, presentationStale: true, acknowledgementsStale: false });
    });
});
