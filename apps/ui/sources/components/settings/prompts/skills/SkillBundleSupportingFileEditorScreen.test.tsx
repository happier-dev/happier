import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushHookEffects, renderScreen } from '@/dev/testkit';
import { createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { createPromptLibraryCatalogBoundary } from '@/dev/testkit/harness/promptLibraryCatalogBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { createPromptBundleArtifact } from '@/sync/ops/promptLibrary/promptBundles';
import { storage } from '@/sync/domains/state/storage';
import { installSkillBundleCommonModuleMocks, skillBundleRouterReplaceSpy } from './skillBundleScreenTestHelpers';

const route = vi.hoisted(() => ({ params: {} as Record<string, string> }));
installSkillBundleCommonModuleMocks({ storage: importOriginal => importOriginal(), router: async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ params: () => route.params, router: { replace: skillBundleRouterReplaceSpy },
        navigation: { canGoBack: () => false } }).module;
} });
// Navigation and browser-hosted Monaco are platform boundaries; draft, codecs,
// captured Account authority and the Artifact HTTP/CAS path stay real.
vi.mock('@react-navigation/native', async importOriginal => ({
    ...await importOriginal<typeof import('@react-navigation/native')>(), usePreventRemove: () => {},
}));

let fixture: Awaited<ReturnType<typeof createPlainArtifactHomeFixture>> | undefined;
beforeEach(async () => {
    await loadSyncSingletonForTests();
    vi.stubGlobal('window', {});
    skillBundleRouterReplaceSpy.mockClear();
    route.params = {};
});
afterEach(() => { fixture?.dispose(); fixture = undefined; vi.unstubAllGlobals(); });

function body(content: string) {
    return { v: 1, createdAtMs: 1, updatedAtMs: 2, entries: [
        { path: 'SKILL.md', contentBase64: Buffer.from('Skill instructions').toString('base64'), contentKind: 'utf8' as const },
        { path: 'templates/review.md', contentBase64: Buffer.from(content).toString('base64'), contentKind: 'utf8' as const },
    ] };
}
async function home() {
    const catalog = createPromptLibraryCatalogBoundary();
    fixture = await createPlainArtifactHomeFixture('https://reviewed-skill-supporting-editor.test', { handleRequest: catalog.handle });
    const id = await createPromptBundleArtifact({ title: 'Skill title', bundleSchemaId: 'skills.skill_md_v1', entries: body('review template').entries });
    return { fixture, id };
}
async function replaceNative(f: NonNullable<typeof fixture>, id: string, content: string) {
    const reviewed = f.boundary.read(id)!;
    const result = await f.boundary.handle(`/v1/artifacts/${id}`, { method: 'POST', body: JSON.stringify({
        body: encodePlainArtifactStoredContent({ body: JSON.stringify(body(content)) }),
        expectedBodyVersion: reviewed.bodyVersion,
        // Direct fixture writes represent retained/native content without a
        // stale private metadata envelope bound to its previous body revision.
        provenance: null, provenanceDataEncryptionKey: null,
    }) });
    if (!result?.ok) throw new Error('Native update failed');
}
async function renderEditor(id: string, path: string | null) {
    const { SkillBundleSupportingFileEditorScreen } = await import('./SkillBundleSupportingFileEditorScreen');
    const screen = await renderScreen(<SkillBundleSupportingFileEditorScreen artifactId={id} path={path} />);
    await vi.waitFor(async () => {
        await flushHookEffects();
        expect(screen.getTextContent()).toContain('promptLibrary.surface.supportingFileDescription');
        expect(screen.findByTestId('skillSupportingFile.save')?.props.disabled).toBe(path === null);
    });
    return screen;
}
function savedEntry(f: NonNullable<typeof fixture>, id: string, path: string) {
    const stored = JSON.parse(f.boundary.readPlainBody(id)!);
    const entry = stored.entries.find((candidate: { path: string }) => candidate.path === path);
    return entry ? Buffer.from(entry.contentBase64, 'base64').toString() : null;
}

describe('SkillBundleSupportingFileEditorScreen reviewed native content', () => {
    it('loads the current native supporting file rather than an ambient cached body and saves its reviewed revision', async () => {
        const { fixture: f, id } = await home();
        await replaceNative(f, id, 'Current native template');
        const screen = await renderEditor(id, 'templates/review.md');
        expect(screen.findByTestId('skillSupportingFile.path')?.props.value).toBe('templates/review.md');
        expect(screen.findAllByType('TextInput').find(node => node.props.multiline === true)?.props.value).toBe('Current native template');
        await act(async () => { screen.findAllByType('TextInput').find(node => node.props.multiline === true)?.props.onChangeText('Updated template'); });
        await screen.pressByTestIdAsync('skillSupportingFile.save');
        await vi.waitFor(() => expect(savedEntry(f, id, 'templates/review.md')).toBe('Updated template'));
        expect(savedEntry(f, id, 'SKILL.md')).toBe('Skill instructions');
    });

    it('creates a new supporting file entry while preserving existing bundle entries', async () => {
        const { fixture: f, id } = await home();
        const screen = await renderEditor(id, null);
        await act(async () => {
            screen.changeTextByTestId('skillSupportingFile.path', 'docs/checklist.md');
            screen.findAllByType('TextInput').find(node => node.props.multiline === true)?.props.onChangeText('Checklist body');
        });
        await vi.waitFor(() => expect(screen.findByTestId('skillSupportingFile.save')?.props.disabled).toBe(false));
        await screen.pressByTestIdAsync('skillSupportingFile.save');
        await vi.waitFor(() => expect(savedEntry(f, id, 'docs/checklist.md')).toBe('Checklist body'));
        expect(savedEntry(f, id, 'templates/review.md')).toBe('review template');
    });

    it('preserves the native winner and supporting-file draft when the reviewed body revision loses CAS', async () => {
        const { fixture: f, id } = await home();
        const screen = await renderEditor(id, 'templates/review.md');
        await act(async () => { screen.findAllByType('TextInput').find(node => node.props.multiline === true)?.props.onChangeText('Unsaved template draft'); });
        await replaceNative(f, id, 'Native winner template');
        const winner = f.boundary.read(id)!;
        await screen.pressByTestIdAsync('skillSupportingFile.save');
        await flushHookEffects();
        expect(f.boundary.read(id)).toEqual(winner);
        expect(savedEntry(f, id, 'templates/review.md')).toBe('Native winner template');
        expect(screen.findAllByType('TextInput').find(node => node.props.multiline === true)?.props.value).toBe('Unsaved template draft');
        expect(screen.findByTestId('skillSupportingFile.save')?.props.disabled).toBe(false);
        expect(skillBundleRouterReplaceSpy).not.toHaveBeenCalled();
    });

    it('consumes the supporting-file route Home instead of an active Home same-id cache', async () => {
        const { fixture: f, id } = await home();
        const { upsertAndActivateServer, getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
        const { publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
        const other = await upsertAndActivateServer({ serverUrl: 'https://other-skill-supporting-home.test', scope: 'device' });
        const accountId = storage.getState().profileScope!.accountId;
        storage.setState({ settingsScope: { serverId: other.id, accountId }, profileScope: { serverId: other.id, accountId },
            artifacts: { [id]: { id, title: 'Foreign skill', header: { title: 'Foreign skill', kind: 'prompt_bundle.v2' },
                body: JSON.stringify(body('Foreign private template')), access: 'owner', isDecrypted: true,
                headerVersion: 8, bodyVersion: 8, seq: 1, createdAt: 1, updatedAt: 1 } } });
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        route.params = { id, serverId: f.home.id, path: 'templates/review.md' };
        const { EditSkillSupportingFilePage } = await import('@/app/(app)/settings/prompts/skills/[id]/files/edit');
        const screen = await renderScreen(<EditSkillSupportingFilePage />);
        await vi.waitFor(async () => { await flushHookEffects(); expect(screen.findAllByType('TextInput').find(node => node.props.multiline === true)?.props.value).toBe('review template'); });
        await act(async () => { screen.findAllByType('TextInput').find(node => node.props.multiline === true)?.props.onChangeText('Selected Home update'); });
        await screen.pressByTestIdAsync('skillSupportingFile.save');
        await vi.waitFor(() => expect(savedEntry(f, id, 'templates/review.md')).toBe('Selected Home update'));
        expect(storage.getState().artifacts[id]?.bodyVersion).toBe(8);
    });

    it('clears reviewed private supporting content when the captured Account retires', async () => {
        const { id } = await home();
        const screen = await renderEditor(id, 'templates/review.md');
        const { retireActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        await act(async () => { retireActiveServerAccountScopeLifetime(); });
        await flushHookEffects();
        expect(screen.findAllByType('TextInput').find(node => node.props.multiline === true)?.props.value).toBe('');
        expect(screen.findByTestId('skillSupportingFile.save')?.props.disabled).toBe(true);
    });
});
