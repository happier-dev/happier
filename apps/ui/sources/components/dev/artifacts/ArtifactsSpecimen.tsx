import * as React from 'react';
import type { StorageInventoryV1 } from '@happier-dev/protocol/artifacts/artifactActionsV1';

import { ArtifactsBrowser } from '@/components/artifacts/ArtifactsBrowserScreen';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';

/**
 * Dev-only specimen of the Artifacts browser (lab `app-surfaces/artifacts`, frames A1–A8) drawn
 * through the real `ArtifactsBrowser` with the lab's fixtures, so lab and app compare side by side.
 * `state`: `grid` (A1, the root-cause document open beside the grid), `empty` (A3), `loading` (A4),
 * `quota` (A8, an operator budget that is full), `failed` (first load failed), `elsewhere` (only kinds that live in
 * their own place: the default list says what it keeps and offers every kind), `storage` (no limit set: the Account
 * total and each Artifact's size, one not measured yet; storage-view lab scene 4 "List"), `storagePending` (the
 * library listed, the Account's numbers still being read).
 */
export const ARTIFACTS_SPECIMEN_STATES = ['grid', 'empty', 'loading', 'quota', 'failed', 'elsewhere', 'storage', 'storagePending'] as const;
export type ArtifactsSpecimenState = typeof ARTIFACTS_SPECIMEN_STATES[number];

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const ROOT_CAUSE = `## Root cause

\`SettingsPage\` is declared inside a \`useMemo\` whose dependencies include the clock tick. Every recompute mints a new component *type*, so React unmounts the old subtree and mounts a fresh one.

## Fix

1. Hoist \`SettingsPage\` to module scope.
2. Pass \`scope\` and \`onClose\` as props instead of closing over them.
3. Keep the tick inside the clock leaf that renders it.

Verified with React DevTools: one mount across 60 ticks, focus retained.`;

const HANDSHAKE = `export async function retryHandshake(relay) {
  for (let n = 0; n < 5; n++) {
    const res = await relay.open();
    if (res.status !== 503) return res;
    await sleep(250 * 2 ** n);
  }
}`;

/** Stored bytes per fixture as the Home would report them; `a3` has not been measured yet. */
const STORED_SIZE_BYTES: Readonly<Record<string, number>> = {
    a1: 3_480_000, a2: 96_000, a4: 286_000_000, a5: 41_200_000, a6: 12_400, a7: 33_800, a8: 192_000_000, a9: 4_200_000,
};

function fixture(id: string, header: Record<string, unknown>, ageMs: number, body: string | undefined, now: number): DecryptedArtifact {
    const title = typeof header.title === 'string' ? header.title : null;
    const storedSizeBytes = STORED_SIZE_BYTES[id];
    return {
        id, title, header: { title, ...header }, body, headerVersion: 1, bodyVersion: 4, seq: 1,
        createdAt: now - ageMs, updatedAt: now - ageMs, isDecrypted: true, access: 'owner', ownerAccountId: 'specimen-owner',
        ...(storedSizeBytes === undefined ? {} : { storedSizeBytes }),
    };
}

function specimenArtifacts(now: number): readonly DecryptedArtifact[] {
    return [
        fixture('a1', { title: 'Settings modal remount — root cause', source: { sessionId: 'specimen-s1', machineId: 'specimen-m1', path: 'notes/settings-remount.md' } }, 12 * MINUTE, ROOT_CAUSE, now),
        fixture('a2', { title: 'relayHandshake.ts', source: { sessionId: 'specimen-s2', machineId: 'specimen-m2', path: 'src/relay/relayHandshake.ts' } }, HOUR, HANDSHAKE, now),
        fixture('a3', { title: 'Release checklist 0.3' }, DAY, '# Release checklist 0.3\n- [x] Desktop builds signed\n- [x] Relay migration rehearsed\n- [ ] Changelog reviewed by Design\n- [ ] Status page drafted', now),
        fixture('a4', { title: 'Onboarding hero, dark', mime: 'image/png', source: { sessionId: 'specimen-s3', machineId: 'specimen-m1', path: 'design/hero-dark.png' } }, 2 * DAY, undefined, now),
        fixture('a5', { kind: 'work-board.v1', title: 'Q4 launch' }, 3 * DAY, undefined, now),
        fixture('a6', { kind: 'prompt_doc.v2', title: 'Code review' }, 5 * DAY, 'Review the diff like a senior engineer on this team. Lead with correctness, then the canonical owner, then tests that would fail without the change.\n\n> Skip style nits the formatter owns.', now),
        fixture('a7', { kind: 'workflow-definition.v1', title: 'Morning triage' }, 7 * DAY, undefined, now),
        fixture('a8', { title: 'Weekly digest · Sep 29', source: { sessionId: 'specimen-s4', machineId: 'specimen-m2', path: 'digest/2026-09-29.md' } }, 8 * DAY, '## Weekly digest · Sep 29\n14 sessions finished, 3 PRs merged. **#2493** fixed the relay 503 loop; the settings remount is ready for review.', now),
        fixture('a9', { kind: 'memory_doc.v1', title: 'Relay team memory' }, 9 * DAY, undefined, now),
    ];
}

const BUDGET: StorageInventoryV1 = { totalBytes: 18_400_000, artifactLimitBytes: 50_000_000, unmeasuredKinds: [],
    byKind: { artifacts: 18_400_000, pluginArtifacts: 0, discussionAttachments: 0, accountPets: 0, pluginCollections: 0 } };
const FULL: StorageInventoryV1 = { ...BUDGET, totalBytes: 50_000_000, byKind: { ...BUDGET.byKind, artifacts: 50_000_000 } };
/** No limit set: the Account total across kinds; avatars, profile pictures and Team logos are not measured yet. */
const UNLIMITED: StorageInventoryV1 = { totalBytes: 1_840_000_000, artifactLimitBytes: null,
    unmeasuredKinds: ['profilePictures', 'avatars', 'teamLogos'],
    byKind: { artifacts: 1_620_000_000, pluginArtifacts: 24_000_000, discussionAttachments: 86_400_000, accountPets: 98_000_000, pluginCollections: 11_600_000 } };
const NOOP = () => {};

export function ArtifactsSpecimen(props: Readonly<{ state: ArtifactsSpecimenState }>): React.ReactElement {
    const [now] = React.useState(() => Date.now());
    const artifacts = React.useMemo(() => specimenArtifacts(now), [now]);
    switch (props.state) {
        case 'empty': return <ArtifactsBrowser artifacts={[]} loaded loadFailed={false} onRetry={NOOP} usage={null} />;
        case 'loading': return <ArtifactsBrowser artifacts={[]} loaded={false} loadFailed={false} onRetry={NOOP} usage={null} />;
        case 'failed': return <ArtifactsBrowser artifacts={[]} loaded={false} loadFailed onRetry={NOOP} usage={null} />;
        case 'quota': return <ArtifactsBrowser artifacts={artifacts} loaded loadFailed={false} onRetry={NOOP} usage={FULL} />;
        case 'elsewhere': return <ArtifactsBrowser artifacts={artifacts.filter((artifact) => ['a5', 'a6', 'a7'].includes(artifact.id))} loaded loadFailed={false} onRetry={NOOP} usage={BUDGET} />;
        case 'storage': return <ArtifactsBrowser artifacts={artifacts} loaded loadFailed={false} onRetry={NOOP} usage={UNLIMITED} />;
        case 'storagePending': return <ArtifactsBrowser artifacts={artifacts} loaded loadFailed={false} onRetry={NOOP} usage={null} />;
        case 'grid': return <ArtifactsBrowser artifacts={artifacts} loaded loadFailed={false} onRetry={NOOP} usage={BUDGET} initialOpenId="a1" />;
    }
}
