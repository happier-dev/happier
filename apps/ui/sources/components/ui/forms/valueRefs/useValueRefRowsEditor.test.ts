import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { ValueRefV1 } from '@happier-dev/protocol/valueRefs/valueRefV1';

import { renderHook } from '@/dev/testkit';

import { useValueRefRowsEditor } from './useValueRefRowsEditor';

describe('useValueRefRowsEditor', () => {
    it('keeps unchanged references lossless through rename and only changes the chosen row', async () => {
        const template = {
            t: 'template', template: 'Bearer {api_key}',
            vars: { api_key: { t: 'savedSecret', secretId: 'personal-key' } },
        } as const;
        const attested = { t: 'sessionAttested', field: 'externalPrincipalId' } as const;
        const entries = { Authorization: template, 'X-Principal': attested };
        const onChangeEntries = vi.fn();
        const hook = await renderHook(() => useValueRefRowsEditor({ kind: 'header', entries, onChangeEntries }));

        await act(async () => { hook.getCurrent().beginEdit('Authorization'); });
        await act(async () => { hook.getCurrent().setDraftKey(' X-Authorization '); });
        await act(async () => { expect(hook.getCurrent().submitDraft()).toEqual({ ok: true }); });

        const next = onChangeEntries.mock.calls[0][0];
        expect(next).toEqual({ 'X-Authorization': template, 'X-Principal': attested });
        expect(next['X-Authorization']).toBe(template);
        expect(next['X-Principal']).toBe(attested);
        expect(hook.getCurrent().draft).toBeNull();
        await act(async () => { hook.getCurrent().beginEdit('X-Principal'); });
        await act(async () => { expect(hook.getCurrent().submitDraft()).toEqual({ ok: true }); });
        expect(onChangeEntries).toHaveBeenCalledTimes(1);
    });

    it('makes machine values an explicit choice and keeps the chosen variable when the row is renamed', async () => {
        const onChangeEntries = vi.fn();
        const hook = await renderHook(() => useValueRefRowsEditor({ kind: 'env', entries: {}, onChangeEntries }));
        await act(async () => { hook.getCurrent().beginAdd(); });
        await act(async () => { hook.getCurrent().setDraftKey(' api_key '); });
        await act(async () => { hook.getCurrent().setDraftSource('machine'); });
        await act(async () => { hook.getCurrent().setDraftMachineVariable('SERVICE_TOKEN'); });
        await act(async () => { hook.getCurrent().setDraftKey('renamed_key'); });
        expect(hook.getCurrent().canSubmit).toBe(true);
        await act(async () => { expect(hook.getCurrent().submitDraft()).toEqual({ ok: true }); });
        expect(onChangeEntries).toHaveBeenCalledWith({ RENAMED_KEY: { t: 'literal', v: '${SERVICE_TOKEN}' } });
    });

    it('rejects invalid names and incomplete saved-secret choices without losing the draft', async () => {
        const onChangeEntries = vi.fn();
        const hook = await renderHook(() => useValueRefRowsEditor({ kind: 'env', entries: {}, onChangeEntries }));
        await act(async () => { hook.getCurrent().beginAdd(); });
        await act(async () => { hook.getCurrent().setDraftKey('bad name'); });
        await act(async () => { expect(hook.getCurrent().submitDraft()).toEqual({ ok: false, error: 'invalid_key' }); });
        await act(async () => { hook.getCurrent().setDraftKey('KEY'); });
        await act(async () => { hook.getCurrent().setDraftSource('savedSecret'); });
        expect(hook.getCurrent().canSubmit).toBe(false);
        await act(async () => { expect(hook.getCurrent().submitDraft()).toEqual({ ok: false, error: 'invalid_value' }); });
        expect(hook.getCurrent().draft?.key).toBe('KEY');
        expect(onChangeEntries).not.toHaveBeenCalled();
        await act(async () => { hook.getCurrent().setDraftValueRef({ t: 'savedSecret', secretId: 'personal-key' }); });
        await act(async () => { expect(hook.getCurrent().submitDraft()).toEqual({ ok: true }); });
        expect(onChangeEntries).toHaveBeenCalledWith({ KEY: { t: 'savedSecret', secretId: 'personal-key' } });
    });

    it('clears a saved-secret selection until a replacement is chosen without writing the cleared value', async () => {
        const onChangeEntries = vi.fn();
        const hook = await renderHook(() => useValueRefRowsEditor({
            kind: 'env', entries: { API_KEY: { t: 'savedSecret', secretId: 'original-key' } }, onChangeEntries,
        }));
        await act(async () => { hook.getCurrent().beginEdit('API_KEY'); });
        expect(hook.getCurrent().canSubmit).toBe(true);
        await act(async () => { hook.getCurrent().setDraftSecretId(null); });
        expect(hook.getCurrent().draft?.secretId).toBe('');
        expect(hook.getCurrent().valueRef).toEqual({ t: 'savedSecret', secretId: '' });
        expect(hook.getCurrent().canSubmit).toBe(false);
        expect(hook.getCurrent().submitDraft()).toEqual({ ok: false, error: 'invalid_value' });
        expect(onChangeEntries).not.toHaveBeenCalled();
        await act(async () => { hook.getCurrent().setDraftSecretId('replacement-key'); });
        expect(hook.getCurrent().canSubmit).toBe(true);
        await act(async () => { expect(hook.getCurrent().submitDraft()).toEqual({ ok: true }); });
        expect(onChangeEntries).toHaveBeenCalledWith({ API_KEY: { t: 'savedSecret', secretId: 'replacement-key' } });
    });

    it('uses current entries for delayed submissions and rejects duplicate renames without overwriting', async () => {
        const first = { t: 'literal', v: 'one' } as const;
        const second = { t: 'literal', v: 'two' } as const;
        const entries: Record<string, ValueRefV1> = { First: first };
        const onChangeEntries = vi.fn();
        const hook = await renderHook((entries: Record<string, ValueRefV1>) => useValueRefRowsEditor({
            kind: 'header', entries, onChangeEntries,
        }), { initialProps: entries });
        const delayedSubmit = hook.getCurrent().submitEntry;
        const firstRow = hook.getCurrent().rows[0];
        await hook.rerender({ First: first, Second: second });
        expect(hook.getCurrent().rows[0]).toBe(firstRow);
        expect(delayedSubmit('First', 'Second', first)).toEqual({ ok: false, error: 'duplicate_key' });
        expect(onChangeEntries).not.toHaveBeenCalled();
        expect(delayedSubmit('First', 'Renamed', first)).toEqual({ ok: true });
        expect(onChangeEntries).toHaveBeenCalledWith({ Renamed: first, Second: second });
        expect(hook.getCurrent().removeEntry('absent')).toEqual({ ok: false, error: 'missing_entry' });
        expect(hook.getCurrent().removeEntry('First')).toEqual({ ok: true });
        expect(onChangeEntries).toHaveBeenLastCalledWith({ Second: second });
    });

    it('edits templates as canonical references and treats cancel and unchanged saves as no writes', async () => {
        const original = { t: 'literal', v: 'existing' } as const;
        const onChangeEntries = vi.fn();
        const hook = await renderHook(() => useValueRefRowsEditor({ kind: 'header', entries: { Authorization: original }, onChangeEntries }));
        await act(async () => { hook.getCurrent().beginEdit('Authorization'); });
        const rows = hook.getCurrent().rows;
        await act(async () => { hook.getCurrent().setDraftSource('template'); });
        await act(async () => { hook.getCurrent().setDraftValueRef({
            t: 'template', template: 'Bearer {key}', vars: { key: { t: 'savedSecret', secretId: 'key-ref' } },
        }); });
        expect(hook.getCurrent().rows).toBe(rows);
        await act(async () => { expect(hook.getCurrent().submitDraft()).toEqual({ ok: true }); });
        expect(onChangeEntries).toHaveBeenCalledWith({ Authorization: {
            t: 'template', template: 'Bearer {key}', vars: { key: { t: 'savedSecret', secretId: 'key-ref' } },
        } });
        onChangeEntries.mockClear();
        await act(async () => { hook.getCurrent().beginAdd(); });
        await act(async () => { hook.getCurrent().cancelDraft(); });
        expect(hook.getCurrent().submitDraft()).toEqual({ ok: false, error: 'no_draft' });
        expect(onChangeEntries).not.toHaveBeenCalled();
    });
});
