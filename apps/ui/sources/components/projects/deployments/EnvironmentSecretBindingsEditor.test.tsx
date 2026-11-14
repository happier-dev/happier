import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { environmentSecretBindingIdentityV1, type EnvironmentSecretBindingV1 } from '@happier-dev/deployment-protocol';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { renderHook } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const owner = await import('./useEnvironmentSecretBindingsEditor');

const secret = { kind: 'secret' as const, ref: formatSharedSavedSecretRefV1('password'), resourceRevision: 2 };
const grantRef = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const runtime: EnvironmentSecretBindingV1 = { purpose: 'variable', name: 'PASSWORD', phase: 'runtime', grantRef: grantRef(1), source: secret };
const registry: EnvironmentSecretBindingV1 = { purpose: 'registry', targetLinkId: 'runtime-link',
    registryOrigin: 'https://registry.example.test', access: 'pull', source: secret };

describe('Environment secret binding editor data', () => {
    it('retains unfinished bulk input and its choices until cancel or the Environment changes', async () => {
        const hook = await renderHook((scopeKey: string) => owner.useEnvironmentSecretBindingsEditor({
            bindings: [runtime], scopeKey, onChangeBindings: vi.fn(),
        }), { initialProps: 'environment-a' });
        const input = { text: 'unfinished line', kinds: { TOKEN: 'plain' as const }, sources: { PASSWORD: secret } };
        await act(async () => { hook.getCurrent().setBulkInput(input); });
        await hook.rerender('environment-a');
        expect(hook.getCurrent().bulkInput).toEqual(input);
        await act(async () => { hook.getCurrent().cancelBulk(); });
        expect(hook.getCurrent().bulkInput).toBeNull();
        await act(async () => { hook.getCurrent().setBulkInput(input); });
        const stale = hook.getCurrent();
        await hook.rerender('environment-b');
        expect(hook.getCurrent().bulkInput).toBeNull();
        await act(async () => { stale.setBulkInput(input); });
        expect(hook.getCurrent().bulkInput).toBeNull();
    });
    it.each(['add', 'rename'] as const)('keeps a saved-secret reference classified as secret on bulk %s', async change => {
        const changed = vi.fn();
        const hook = await renderHook(() => owner.useEnvironmentSecretBindingsEditor({ bindings: [runtime], onChangeBindings: changed }));
        const file = hook.getCurrent().bulkText();
        const renamed = file.replace('PASSWORD', 'COPIED_VALUE');
        await act(async () => { expect(hook.getCurrent().stageBulk(change === 'add' ? `${file}\n${renamed}` : renamed, 'runtime'))
            .toEqual({ ok: true }); });
        expect(hook.getCurrent().bulk).toMatchObject([{ name: 'COPIED_VALUE', change: 'added', source: secret, classification: 'secret' }]);
        await act(async () => { expect(hook.getCurrent().applyBulk({})).toEqual({ ok: true }); });
        const next = changed.mock.calls[0]?.[0] as readonly EnvironmentSecretBindingV1[];
        expect(next).toHaveLength(change === 'add' ? 2 : 1);
        if (change === 'add') expect(next[0]).toBe(runtime);
        const copied = next.find(binding => binding.purpose === 'variable' && binding.name === 'COPIED_VALUE');
        expect(copied).toMatchObject({ purpose: 'variable', phase: 'runtime', name: 'COPIED_VALUE', source: secret });
        expect(copied?.purpose === 'variable' ? copied.grantRef : undefined).not.toBe(runtime.grantRef);
    });

    it('converts one existing variable to Both as one validated local pair without changing sibling bindings', async () => {
        const changed = vi.fn();
        const hook = await renderHook(() => owner.useEnvironmentSecretBindingsEditor({ bindings: [runtime, registry], onChangeBindings: changed }));
        const pair = [{ ...runtime, phase: 'build' as const }, runtime];
        const conversion = { name: runtime.name, phase: 'both' as const, source: runtime.source,
            originalIdentity: environmentSecretBindingIdentityV1(runtime) };
        expect(hook.getCurrent().setVariable(conversion)).toEqual({ ok: true });
        expect(changed).toHaveBeenCalledTimes(1);
        const next = changed.mock.calls[0]![0] as readonly EnvironmentSecretBindingV1[];
        expect(next).toHaveLength(3);
        expect(next.find(binding => binding.purpose === 'registry')).toBe(registry);
        expect(next.filter(binding => binding.purpose === 'variable').map(binding => environmentSecretBindingIdentityV1(binding)).sort())
            .toEqual(pair.map(environmentSecretBindingIdentityV1).sort());
        const convertedRuntime = next.find(binding => binding.purpose === 'variable' && binding.phase === 'runtime');
        const convertedBuild = next.find(binding => binding.purpose === 'variable' && binding.phase === 'build');
        expect(convertedRuntime?.purpose === 'variable' ? convertedRuntime.grantRef : undefined).toBe(runtime.grantRef);
        expect(convertedBuild?.purpose === 'variable' ? convertedBuild.grantRef : undefined).not.toBe(runtime.grantRef);
        changed.mockClear();
        const opposing = { ...runtime, phase: 'build' as const, grantRef: grantRef(2) };
        const collision = await renderHook(() => owner.useEnvironmentSecretBindingsEditor({ bindings: [opposing, runtime], onChangeBindings: changed }));
        expect(collision.getCurrent().setVariable(conversion))
            .toEqual({ ok: false, error: 'duplicate_identity' });
        const managed = await renderHook(() => owner.useEnvironmentSecretBindingsEditor({ bindings: [runtime],
            managedIdentities: new Set([environmentSecretBindingIdentityV1(runtime)]), onChangeBindings: changed }));
        expect(managed.getCurrent().setVariable(conversion))
            .toEqual({ ok: false, error: 'managed' });
        expect(changed).not.toHaveBeenCalled();
    });

    it('clears raw bulk on editor scope changes and refuses edits while the parent is unavailable', async () => {
        const changed = vi.fn();
        const hook = await renderHook((scopeKey: string) => {
            const options = { bindings: [runtime], scopeKey, readOnly: scopeKey === 'retired', onChangeBindings: changed };
            return owner.useEnvironmentSecretBindingsEditor(options);
        }, { initialProps: 'environment-a' });
        await act(async () => { hook.getCurrent().stageBulk('TOKEN=local-draft-only', 'runtime'); });
        expect(hook.getCurrent().bulk?.[0]?.value).toBe('local-draft-only');
        const stale = hook.getCurrent();
        await hook.rerender('environment-b');
        expect(hook.getCurrent().bulk).toBeNull();
        await act(async () => { hook.getCurrent().stageBulk('TOKEN=next-owner-draft', 'runtime'); });
        await act(async () => {
            expect(stale.stageBulk('TOKEN=stale-owner-draft', 'runtime')).toEqual({ ok: false, error: 'unavailable' });
            stale.classifyBulk('TOKEN', 'plain');
            expect(stale.setVariable({ name: 'STALE', phase: 'runtime', source: { kind: 'value', value: 'wrong-owner' } }))
                .toEqual({ ok: false, error: 'unavailable' });
        });
        expect(hook.getCurrent().bulk?.[0]).toMatchObject({ value: 'next-owner-draft', classification: 'secret' });
        await hook.rerender('retired');
        expect(hook.getCurrent().setVariable({ name: 'PORT', phase: 'runtime', source: { kind: 'value', value: '3000' } }))
            .toEqual({ ok: false, error: 'unavailable' });
        expect(hook.getCurrent().stageBulk('TOKEN=must-not-stage', 'runtime')).toEqual({ ok: false, error: 'unavailable' });
        expect(hook.getCurrent().bulk).toBeNull();
        expect(changed).not.toHaveBeenCalled();
    });
    it('keeps exact masked refs and purpose identities through a variable edit and operational removal', async () => {
        const backup: EnvironmentSecretBindingV1 = { purpose: 'backupDestination', configKey: 'destination', role: 'sshPrivateKey', source: secret };
        const bindings = [runtime, registry, backup];
        const changed = vi.fn();
        const hook = await renderHook(() => owner.useEnvironmentSecretBindingsEditor({ bindings, onChangeBindings: changed }));
        expect(hook.getCurrent().rows.map(row => row.hasPhaseControl)).toEqual([true, false, false]);
        await act(async () => {
            expect(hook.getCurrent().put({ ...runtime, name: 'RENAMED' }, environmentSecretBindingIdentityV1(runtime))).toEqual({ ok: true });
        });
        const next = changed.mock.calls[0][0] as readonly EnvironmentSecretBindingV1[];
        expect(next[0]?.source).toEqual(secret);
        expect(next[0]?.purpose === 'variable' ? next[0].grantRef : undefined).not.toBe(runtime.grantRef);
        expect(next[1]).toBe(registry);
        expect(next[2]).toBe(backup);
        changed.mockClear();
        expect(hook.getCurrent().remove(environmentSecretBindingIdentityV1(backup))).toEqual({ ok: true });
        expect(changed).toHaveBeenCalledWith([runtime, registry]);
    });

    it('expands Both into canonical rows and refuses duplicate/managed edits without a local write', async () => {
        const changed = vi.fn();
        const hook = await renderHook(() => owner.useEnvironmentSecretBindingsEditor({ bindings: [registry],
            managedIdentities: new Set([environmentSecretBindingIdentityV1(registry)]), onChangeBindings: changed }));
        expect(hook.getCurrent().remove(environmentSecretBindingIdentityV1(registry))).toEqual({ ok: false, error: 'managed' });
        expect(hook.getCurrent().setVariable({ name: 'PORT', phase: 'both', source: { kind: 'value', value: '3000' } })).toEqual({ ok: true });
        const next = changed.mock.calls[0]?.[0] as readonly EnvironmentSecretBindingV1[];
        expect(next[0]).toBe(registry);
        const ports = next.filter((binding): binding is Extract<EnvironmentSecretBindingV1, { purpose: 'variable' }> =>
            binding.purpose === 'variable' && binding.name === 'PORT');
        expect(ports).toMatchObject([
            { purpose: 'variable', phase: 'build', name: 'PORT', source: { kind: 'value', value: '3000' } },
            { purpose: 'variable', phase: 'runtime', name: 'PORT', source: { kind: 'value', value: '3000' } },
        ]);
        expect(new Set(ports.map(binding => binding.grantRef)).size).toBe(2);
        expect(hook.getCurrent().put({ ...registry, access: 'pushPull' })).toEqual({ ok: false, error: 'managed' });
        expect(changed).toHaveBeenCalledTimes(1);
    });

    it('keeps bulk bytes local until every secret row has an exact selection, while plain rows create no secret input', async () => {
        const changed = vi.fn();
        const hook = await renderHook(() => owner.useEnvironmentSecretBindingsEditor({ bindings: [runtime, registry], onChangeBindings: changed }));
        await act(async () => { expect(hook.getCurrent().stageBulk(`${hook.getCurrent().bulkText()}\nTOKEN=private-draft-sentinel\nPORT=3000`, 'runtime')).toEqual({ ok: true }); });
        // Happier guesses from the name; the person decides before Save.
        expect(hook.getCurrent().bulk?.map(row => row.classification)).toEqual(['secret', 'plain']);
        expect(changed).not.toHaveBeenCalled();
        await act(async () => { hook.getCurrent().classifyBulk('PORT', 'plain'); });
        expect(hook.getCurrent().applyBulk({})).toEqual({ ok: false, error: 'selection_required' });
        expect(changed).not.toHaveBeenCalled();
        await act(async () => { expect(hook.getCurrent().applyBulk({ TOKEN: secret })).toEqual({ ok: true }); });
        const next = changed.mock.calls[0]?.[0] as readonly EnvironmentSecretBindingV1[];
        expect(next[0]).toBe(runtime);
        expect(next[1]).toBe(registry);
        expect(next).toMatchObject([runtime, registry,
            { purpose: 'variable', phase: 'runtime', name: 'TOKEN', source: secret },
            { purpose: 'variable', phase: 'runtime', name: 'PORT', source: { kind: 'value', value: '3000' } }]);
        const variables = next.filter((binding): binding is Extract<EnvironmentSecretBindingV1, { purpose: 'variable' }> => binding.purpose === 'variable');
        expect(new Set(variables.map(binding => binding.grantRef)).size).toBe(3);
        expect(JSON.stringify(next)).not.toContain('private-draft-sentinel');
        expect(hook.getCurrent().bulk).toBeNull();
    });

    it.each(['cancel', 'replacement', 'classification'] as const)(
        'rejects a retained bulk selection after %s and keeps the current draft usable', async change => {
            const changed = vi.fn();
            const hook = await renderHook(() => owner.useEnvironmentSecretBindingsEditor({ bindings: [runtime], onChangeBindings: changed }));
            await act(async () => { hook.getCurrent().stageBulk(`${hook.getCurrent().bulkText()}\nTOKEN=first-local-draft`, 'runtime'); });
            if (change === 'cancel') await act(async () => { hook.getCurrent().classifyBulk('TOKEN', 'plain'); });
            const staleApply = hook.getCurrent().applyBulk;
            await act(async () => {
                if (change === 'cancel') hook.getCurrent().cancelBulk();
                else if (change === 'replacement') hook.getCurrent().stageBulk(`${hook.getCurrent().bulkText()}\nTOKEN=replacement-local-draft`, 'runtime');
                else hook.getCurrent().classifyBulk('TOKEN', 'plain');
                expect(staleApply(change === 'cancel' ? {} : { TOKEN: secret })).toEqual({ ok: false, error: 'no_draft' });
            });
            expect(staleApply(change === 'cancel' ? {} : { TOKEN: secret })).toEqual({ ok: false, error: 'no_draft' });
            expect(changed).not.toHaveBeenCalled();
            if (change === 'cancel') await act(async () => { hook.getCurrent().stageBulk(`${hook.getCurrent().bulkText()}\nTOKEN=new-local-draft`, 'runtime'); });
            await act(async () => { hook.getCurrent().classifyBulk('TOKEN', 'plain'); });
            await act(async () => { expect(hook.getCurrent().applyBulk({})).toEqual({ ok: true }); });
            const value = change === 'replacement' ? 'replacement-local-draft'
                : change === 'cancel' ? 'new-local-draft' : 'first-local-draft';
            expect(changed).toHaveBeenCalledTimes(1);
            const next = changed.mock.calls[0]?.[0] as readonly EnvironmentSecretBindingV1[];
            expect(next[0]).toBe(runtime);
            expect(next[1]).toMatchObject({ purpose: 'variable', name: 'TOKEN', phase: 'runtime',
                source: { kind: 'value', value } });
            expect(next[1]?.purpose === 'variable' ? next[1].grantRef : undefined).not.toBe(runtime.grantRef);
        });

    it('stages the whole file from current bindings, keeps references unchanged, and diffs edits, additions and removals into one write', async () => {
        const changed = vi.fn();
        const logLevel: EnvironmentSecretBindingV1 = { purpose: 'variable', name: 'LOG_LEVEL', phase: 'runtime', grantRef: grantRef(3), source: { kind: 'value', value: 'info' } };
        const originBuild: EnvironmentSecretBindingV1 = { purpose: 'variable', name: 'ORIGIN', phase: 'build', grantRef: grantRef(4), source: { kind: 'value', value: 'https://api.example.test' } };
        const originRuntime: EnvironmentSecretBindingV1 = { ...originBuild, phase: 'runtime', grantRef: grantRef(5) };
        const old: EnvironmentSecretBindingV1 = { purpose: 'variable', name: 'OLD_FLAG', phase: 'runtime', grantRef: grantRef(6), source: { kind: 'value', value: 'x' } };
        const bindings = [runtime, logLevel, originBuild, originRuntime, old, registry];
        const hook = await renderHook(() => owner.useEnvironmentSecretBindingsEditor({ bindings, onChangeBindings: changed }));
        const file = hook.getCurrent().bulkText();
        // Every current entry is in the file; a secret is a reference, never a value.
        expect(file).toMatch(/^PASSWORD\s+= ‹.+›$/mu);
        expect(file).toMatch(/^LOG_LEVEL\s+= info$/mu);
        expect(file).toMatch(/^ORIGIN\s+= https:\/\/api\.example\.test\s+# build \+ runtime$/mu);
        expect(file).toMatch(/^OLD_FLAG\s+= x$/mu);
        const edited = file.split('\n').filter(line => !line.startsWith('OLD_FLAG'))
            .map(line => line.startsWith('LOG_LEVEL') ? 'LOG_LEVEL = debug' : line)
            .concat(['SENTRY_DSN = dsn-local-sentinel', 'FEATURE_CART_V2 = true']).join('\n');
        await act(async () => { expect(hook.getCurrent().stageBulk(edited, 'runtime')).toEqual({ ok: true }); });
        expect(hook.getCurrent().bulk?.map(row => [row.name, row.change, row.classification])).toEqual([
            ['LOG_LEVEL', 'changed', 'plain'], ['SENTRY_DSN', 'added', 'secret'], ['FEATURE_CART_V2', 'added', 'plain']]);
        expect(hook.getCurrent().bulkRemoved).toEqual(['OLD_FLAG']);
        expect(changed).not.toHaveBeenCalled();
        const dsn = { kind: 'secret' as const, ref: formatSharedSavedSecretRefV1('sentry-dsn'), resourceRevision: 1 };
        await act(async () => { expect(hook.getCurrent().applyBulk({ SENTRY_DSN: dsn })).toEqual({ ok: true }); });
        expect(changed).toHaveBeenCalledTimes(1);
        const next = changed.mock.calls[0]![0] as readonly EnvironmentSecretBindingV1[];
        expect(next[0]).toBe(runtime);
        expect(next[2]).toBe(originBuild);
        expect(next[3]).toBe(originRuntime);
        expect(next[4]).toBe(registry);
        expect(next.slice(0, 5)).toEqual([runtime, { ...logLevel, source: { kind: 'value', value: 'debug' } }, originBuild, originRuntime, registry]);
        expect(next.slice(5)).toMatchObject([
            { purpose: 'variable', name: 'SENTRY_DSN', phase: 'runtime', source: dsn },
            { purpose: 'variable', name: 'FEATURE_CART_V2', phase: 'runtime', source: { kind: 'value', value: 'true' } },
        ]);
        const variables = next.filter((binding): binding is Extract<EnvironmentSecretBindingV1, { purpose: 'variable' }> => binding.purpose === 'variable');
        expect(new Set(variables.map(binding => binding.grantRef)).size).toBe(6);
        expect(JSON.stringify(next)).not.toContain('dsn-local-sentinel');
        expect(hook.getCurrent().bulk).toBeNull();
        // A reference the file did not come from is refused rather than guessed.
        await act(async () => { expect(hook.getCurrent().stageBulk('TOKEN = ‹saved: not in this file›', 'runtime'))
            .toEqual({ ok: false, error: 'unknown_reference' }); });
    });

    it('treats no-op, invalid/duplicate names and cancelled bulk as zero controlled writes', async () => {
        const changed = vi.fn();
        const hook = await renderHook(() => owner.useEnvironmentSecretBindingsEditor({ bindings: [runtime], onChangeBindings: changed }));
        expect(hook.getCurrent().put({ ...runtime, source: { ...secret } }, environmentSecretBindingIdentityV1(runtime))).toEqual({ ok: true });
        expect(hook.getCurrent().setVariable({ name: 'bad name', phase: 'runtime', source: { kind: 'value', value: 'x' } })).toEqual({ ok: false, error: 'invalid_binding' });
        expect(hook.getCurrent().put(runtime)).toEqual({ ok: false, error: 'duplicate_identity' });
        await act(async () => { expect(hook.getCurrent().stageBulk('A=one\nA=two', 'runtime')).toEqual({ ok: false, error: 'duplicate_identity' }); });
        await act(async () => { hook.getCurrent().stageBulk('TEMP=local-only', 'build'); });
        await act(async () => { hook.getCurrent().cancelBulk(); });
        await act(async () => { hook.getCurrent().classifyBulk('TEMP', 'plain'); });
        expect(hook.getCurrent().bulk).toBeNull();
        expect(changed).not.toHaveBeenCalled();
    });
});
