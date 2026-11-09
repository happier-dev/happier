import { PluginUiHostApiSurfaceContextV1Schema, type PluginUiTargetedContributionsV1 } from '@happier-dev/protocol/plugins/ui';
import { act } from 'react';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { createPluginSurfaceContextFixture } from '@/dev/testkit/fixtures/pluginSurfaceContextFixture';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { storage } from '@/sync/domains/state/storage';

import { createPluginSurfaceContext, getPluginSurfaceTargetAuthorityKey, resolvePluginSurfaceTarget, usePluginSurfaceEnvironment } from './pluginSurfaceContext';
import { readProjectWidgetAreaContextV1 } from '@/sync/domains/widgets/projectWidgetAreaContext';
import { WorkspaceRefV1Schema } from '@happier-dev/protocol/workspaces/workspaceRefV1';

const targetedContributions: PluginUiTargetedContributionsV1 = {
    target: {
        pluginId: 'acme.preview',
        occurrenceId: 'target-generation-a',
        sourceCustody: { kind: 'development', registeredRootId: 'preview-root' },
    },
    points: [],
};

describe('createPluginSurfaceContext', () => {
    it('discloses the exact Machine target and refuses a missing Home or Machine identity', () => {
        const facts = { targetKind: 'machine' as const, serverId: 'home-a', machineId: 'machine-a',
            homeId: 'home-identity-a', installationId: 'installation-a' };
        const resolution = resolvePluginSurfaceTarget(facts);
        expect(resolution).toEqual({ resolved: true, target: { kind: 'machine', serverId: 'home-a', machineId: 'machine-a',
            homeId: 'home-identity-a', installationId: 'installation-a' } });
        expect(resolvePluginSurfaceTarget({ ...facts, serverId: '' })).toEqual({ resolved: false, reason: 'machine_target_identity_unavailable' });
        expect(resolvePluginSurfaceTarget({ ...facts, machineId: null })).toEqual({ resolved: false, reason: 'machine_target_identity_unavailable' });
        expect(resolvePluginSurfaceTarget({ ...facts, homeId: null, installationId: null })).toEqual({ resolved: true,
            target: { kind: 'machine', serverId: facts.serverId, machineId: facts.machineId } });
        if (!resolution.resolved || resolution.target.kind !== 'machine') throw new Error('Machine identity was not resolved');
        const fixture = createPluginSurfaceContextFixture();
        const published = createPluginSurfaceContext({ mount: { kind: 'destination', destination: { pluginId: 'acme.machine', localId: 'tools' }, container: 'appPage' },
            target: resolution.target, accountEncryptionMode: fixture.accountEncryptionMode,
            environment: { ...fixture, columnVisible: false }, translations: fixture.translations });
        expect(PluginUiHostApiSurfaceContextV1Schema.parse(published).target).toEqual(resolution.target);
        expect(getPluginSurfaceTargetAuthorityKey(resolution.target)).not.toBe(getPluginSurfaceTargetAuthorityKey({ kind: 'machine', serverId: 'home-b', machineId: 'machine-a' }));
        expect(getPluginSurfaceTargetAuthorityKey(resolution.target)).not.toBe(getPluginSurfaceTargetAuthorityKey({ kind: 'machine', serverId: 'home-a', machineId: 'machine-b' }));
        expect(getPluginSurfaceTargetAuthorityKey(resolution.target)).not.toBe(getPluginSurfaceTargetAuthorityKey({
            ...resolution.target, installationId: 'replacement-installation' }));
        expect(getPluginSurfaceTargetAuthorityKey(resolution.target)).not.toBe(getPluginSurfaceTargetAuthorityKey({
            ...resolution.target, homeId: 'replacement-home' }));
        expect(resolvePluginSurfaceTarget({ targetKind: 'services' })).toEqual({ resolved: true, target: { kind: 'services' } });
    });
    it('publishes only the admitted current Account lifetime scope, never a global or retired identity', () => {
        const fixture = createPluginSurfaceContextFixture();
        const input = { mount: fixture.mount, target: fixture.target, accountEncryptionMode: fixture.accountEncryptionMode,
            environment: { ...fixture, columnVisible: false }, translations: fixture.translations };
        const scope = { serverId: 'home-a', accountId: 'viewer-a' };
        let current = true;
        const accountLifetime = { scope, isCurrent: () => current };
        const published = createPluginSurfaceContext({ ...input, accountLifetime });
        expect(PluginUiHostApiSurfaceContextV1Schema.parse(published).accountScope).toEqual(scope);
        expect(published.accountScope).toBe(scope);
        expect(createPluginSurfaceContext(input)).not.toHaveProperty('accountScope');
        current = false;
        expect(createPluginSurfaceContext({ ...input, accountLifetime })).not.toHaveProperty('accountScope');
    });
    it('shares admitted repository, current branch and HEAD facts with the exact Session target', () => {
        const snapshot = { hostingProvider: { id: 'github', kind: 'github' as const, displayName: 'GitHub', baseUrl: 'https://github.com',
            nameWithOwner: 'Owner/Repo', urlSafety: { allowedSchemes: ['https:'] } },
            branch: { head: 'feature/ci', headOid: 'abc123', upstream: null, ahead: 0, behind: 0, detached: false } };
        const facts = { targetKind: 'session' as const, sessionId: 'session-a', agentId: 'codex', snapshot };
        const resolved = resolvePluginSurfaceTarget(facts);
        expect(resolved).toMatchObject({ resolved: true, target: { kind: 'session', sessionId: 'session-a', agentId: 'codex',
            repository: { kind: 'github', deployment: 'https://github.com', repository: 'owner/repo' }, branch: 'feature/ci', headOid: 'abc123' } });
        const detached = resolvePluginSurfaceTarget({ ...facts, snapshot: { ...snapshot, branch: { ...snapshot.branch, detached: true } } });
        expect(detached).toMatchObject({ resolved: true, target: { headOid: 'abc123' } });
        if (detached.resolved) expect(detached.target).not.toHaveProperty('branch');
        expect(resolvePluginSurfaceTarget({ targetKind: 'session', sessionId: 'session-a' })).toEqual({ resolved: true, target: { kind: 'session', sessionId: 'session-a' } });
    });

    it('publishes the canonical logical Project target through the public context reader', () => {
        const checkout = WorkspaceRefV1Schema.parse({ id: 'checkout-address', projectKey: 'logical-project', serverId: 'home', machineId: 'machine', rootPath: '/repo', createdAtMs: 1,
            futurePrivateFact: 'not disclosed', source: { sourceId: 'source', revision: 1, futurePrivateFact: 'not disclosed' },
            repositoryIdentity: { kind: 'github', deployment: 'https://github.com', repository: 'owner/repo', futurePrivateFact: 'not disclosed' } });
        const read = readProjectWidgetAreaContextV1({ serverId: 'home', activeCheckout: checkout });
        const resolution = resolvePluginSurfaceTarget({ targetKind: 'project', project: read.target });
        expect(resolution).toEqual({ resolved: true, target: read.target });
        if (!resolution.resolved) throw new Error('Project identity was not resolved');
        expect(resolution.target).toBe(read.target);
        const fixture = createPluginSurfaceContextFixture();
        const published = createPluginSurfaceContext({ mount: fixture.mount, target: resolution.target,
            accountEncryptionMode: fixture.accountEncryptionMode, environment: { ...fixture, columnVisible: false }, translations: fixture.translations });
        expect(PluginUiHostApiSurfaceContextV1Schema.parse(published).target).toEqual(read.target);
        expect(checkout).not.toHaveProperty('futurePrivateFact');
        expect(checkout.source).not.toHaveProperty('futurePrivateFact');
        expect(checkout.repositoryIdentity).not.toHaveProperty('futurePrivateFact');
        const anotherCheckout = readProjectWidgetAreaContextV1({ serverId: 'home', activeCheckout: { ...checkout, id: 'another-checkout', rootPath: '/other' } }, read);
        expect(anotherCheckout.target).not.toBe(read.target);
        expect(getPluginSurfaceTargetAuthorityKey(anotherCheckout.target!)).toBe(getPluginSurfaceTargetAuthorityKey(read.target!));
        expect(resolvePluginSurfaceTarget({ targetKind: 'project', project: null })).toEqual({ resolved: false, reason: 'project_target_identity_unavailable' });
    });
    it('freezes host-owned surface facts while fresh changed publications leave previous content intact', () => {
        const fixture = createPluginSurfaceContextFixture();
        const translations = { title: 'Original' };
        const input = {
            mount: fixture.mount,
            target: fixture.target,
            accountEncryptionMode: fixture.accountEncryptionMode,
            environment: { ...fixture, columnVisible: false },
            translations,
            targetedContributions: fixture.targetedContributions,
        };
        const published = createPluginSurfaceContext(input);
        expect(Object.isFrozen(published.translations)).toBe(true);
        expect(Reflect.set(translations, 'title', 'Changed')).toBe(false);
        expect(published.translations.title).toBe('Original');
        const next = createPluginSurfaceContext({ ...input, translations: { title: 'Changed' } });
        expect(next.translations.title).toBe('Changed');
        expect(next.target).toBe(published.target);
        expect(next.theme).toBe(published.theme);
    });
    it('projects live local spinner preferences without subscribing to unrelated local settings', async () => {
        const previous = storage.getState();
        onTestFinished(() => { storage.setState(previous, true); });
        storage.setState({ localSettings: { ...previous.localSettings,
            loadingIndicatorStyle: 'hWave', loadingIndicatorSpeed: 'slow', loadingIndicatorPause: 'long',
        } });
        let renders = 0;
        const hook = await renderHook(() => {
            renders += 1;
            return usePluginSurfaceEnvironment('web');
        });
        onTestFinished(() => hook.unmount());
        const initial = hook.getCurrent();
        expect(initial.theme.spinner).toEqual({ style: 'hWave', speed: 'slow', pause: 'long' });
        const initialRenders = renders;
        await act(async () => {
            storage.setState({ localSettings: { ...storage.getState().localSettings,
                uiItemDensity: previous.localSettings.uiItemDensity === 'compact' ? 'comfortable' : 'compact',
            } });
        });
        expect(renders).toBe(initialRenders);
        expect(hook.getCurrent()).toBe(initial);
        await act(async () => {
            storage.setState({ localSettings: { ...storage.getState().localSettings,
                loadingIndicatorStyle: 'classicRing', loadingIndicatorSpeed: 'fast', loadingIndicatorPause: 'none',
            } });
        });
        expect(hook.getCurrent().theme.spinner).toEqual({ style: 'classicRing', speed: 'fast', pause: 'none' });
        expect(hook.getCurrent().reducedMotion).toBe(initial.reducedMotion);
    });
    it('tells a page companion which page opened it, and no other mount', () => {
        const fixture = createPluginSurfaceContextFixture();
        const environment = {
            platform: fixture.platform, locale: fixture.locale, direction: fixture.direction, colorScheme: fixture.colorScheme,
            contrast: fixture.contrast, textScale: fixture.textScale, reducedMotion: fixture.reducedMotion,
            screenReaderEnabled: fixture.screenReaderEnabled, safeAreaInsets: fixture.safeAreaInsets, theme: fixture.theme,
            columnVisible: true,
        };
        const companionMount = { kind: 'destination' as const, destination: { pluginId: 'happier.triage', localId: 'entry-session' },
            container: 'rightSidebarTab' as const };
        const input = { target: { kind: 'app' as const }, accountEncryptionMode: fixture.accountEncryptionMode,
            translations: fixture.translations, targetedContributions, mount: companionMount };
        const openedFrom = { pageKind: { pluginId: 'happier.triage', localId: 'triage' }, subPath: 'e,issue,56' };
        const context = createPluginSurfaceContext({ ...input, environment: { ...environment, openedFrom } });
        expect(context.openedFrom).toEqual(openedFrom);
        expect(PluginUiHostApiSurfaceContextV1Schema.safeParse(context).success).toBe(true);
        expect(createPluginSurfaceContext({ ...input, environment }).openedFrom).toBeUndefined();
    });

    it('projects the shell column visibility only for an app page', () => {
        const fixture = createPluginSurfaceContextFixture();
        const environment = {
            platform: fixture.platform,
            locale: fixture.locale,
            direction: fixture.direction,
            colorScheme: fixture.colorScheme,
            contrast: fixture.contrast,
            textScale: fixture.textScale,
            reducedMotion: fixture.reducedMotion,
            screenReaderEnabled: fixture.screenReaderEnabled,
            safeAreaInsets: fixture.safeAreaInsets,
            theme: fixture.theme,
            columnVisible: true,
        };
        const input = {
            target: { kind: 'app' as const },
            accountEncryptionMode: fixture.accountEncryptionMode,
            environment,
            translations: fixture.translations,
            targetedContributions,
        };
        const appPageMount = {
            kind: 'destination' as const,
            destination: { pluginId: 'acme.preview', localId: 'inbox' },
            container: 'appPage' as const,
        };
        expect(createPluginSurfaceContext({ ...input, mount: appPageMount }).page).toEqual({ columnVisible: true });
        expect(createPluginSurfaceContext({ ...input, mount: appPageMount, environment: { ...environment, columnVisible: false } }).page).toEqual({ columnVisible: false });
        expect(createPluginSurfaceContext({ ...input, mount: fixture.mount }).page).toBeUndefined();
    });

    it('projects the host-stamped mount and exact admitted target snapshot', () => {
        const fixture = createPluginSurfaceContextFixture();
        const targeted = createPluginSurfaceContext({
            mount: fixture.mount,
            target: fixture.target,
            accountEncryptionMode: fixture.accountEncryptionMode,
            environment: {
                platform: fixture.platform,
                locale: fixture.locale,
                direction: fixture.direction,
                colorScheme: fixture.colorScheme,
                contrast: fixture.contrast,
                textScale: fixture.textScale,
                reducedMotion: fixture.reducedMotion,
                screenReaderEnabled: fixture.screenReaderEnabled,
                safeAreaInsets: fixture.safeAreaInsets,
                theme: fixture.theme,
                columnVisible: false,
            },
            translations: fixture.translations,
            targetedContributions,
            machineConnectionPending: true,
            machineExecutionReady: false,
            requesterExecutionReady: false,
        });

        expect(targeted.mount).toBe(fixture.mount);
        expect(targeted.accountEncryptionMode).toBe(fixture.accountEncryptionMode);
        expect(targeted.targetedContributions).toBe(targetedContributions);
        // Both physical transports use this producer and the SDK's strict
        // context reader; pending is presentation, never surface inactivity.
        expect(PluginUiHostApiSurfaceContextV1Schema.parse(targeted)).toMatchObject({
            machineConnectionPending: true, machineExecutionReady: false, requesterExecutionReady: false,
        });
    });

});
