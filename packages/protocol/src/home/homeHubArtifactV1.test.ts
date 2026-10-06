import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createWorkBoardArtifactBoundary } from '../boards/workBoardArtifactV1.testkit.js';
import { createHomeHubArtifactPortV1, buildHomeHubArtifactIdV1, HOME_HUB_ARTIFACT_KIND_V1, type HomeHubArtifactTransportV1 } from './homeHubArtifactV1.js';
import { HOME_HUB_DEFAULT_LAYOUT, homeHubDefaultWidgetInstanceId, type HomeHubWidgetInput } from './homeHubLayoutV1.js';

const shown: HomeHubWidgetInput = { key: 'acme.checks/summary', surface: { pluginId: 'acme.checks', localId: 'summary' }, homeDefault: 'shown' };
const copy = (id: string, session: string) => ({ v: 1 as const, id, definition: { kind: 'installed' as const, surface: shown.surface }, bindings: { session: { kind: 'value' as const, value: session } } });
const accountId = 'account-one';
function boundary() {
    const b = createWorkBoardArtifactBoundary();
    const transport: HomeHubArtifactTransportV1 = { ...b.transport, create: async input => {
        await b.transport.create(input);
        return { ...b.rows.get(input.artifactId)!, ownerAccountId: accountId };
    }, read: async (id, options) => {
        const row = await b.transport.read(id, options);
        return row ? { ...row, ownerAccountId: accountId } : null;
    } };
    return { ...b, transport };
}

describe('Home Account Artifact semantic edits', () => {
    it.each([
        { v: 1, order: ['setup'], hidden: ['setup:addPhone'] },
        { v: 1, order: ['setup'], instances: [] },
        { order: ['setup'], hidden: [], obsolete: true },
    ])('normalizes partial stored layouts before projections and semantic edits: %j', async stored => {
        const b = boundary();
        const id = buildHomeHubArtifactIdV1(accountId);
        b.rows.set(id, { artifactId: id, header: { v: 1, kind: HOME_HUB_ARTIFACT_KIND_V1 }, body: JSON.stringify(stored), revision: { headerVersion: 1, bodyVersion: 1 } });
        const port = createHomeHubArtifactPortV1(b.transport, { accountId });
        const layout = await port.read();
        expect(layout).toEqual({ ...HOME_HUB_DEFAULT_LAYOUT, order: stored.order, hidden: 'hidden' in stored ? stored.hidden : [] });
        expect((await port.describe(layout)).sections.find(section => section.id === 'setup')).toMatchObject({ hidden: false });
        expect(b.updates).toEqual([]);
        const edited = (await port.apply({ kind: 'setup_visibility', stepId: 'addMachine', hidden: true })).layout;
        expect(edited.hidden).toContain('setup:addMachine');
        expect(edited.instances).toEqual([]);
        expect(await port.read()).toEqual(edited);
    });

    it.each(['corrupt', JSON.stringify(null), JSON.stringify({ v: 1, hidden: 'bad' }), JSON.stringify({ v: 2, order: [] })])('reads invalid layout content as defaults without a mount write: %s', async body => {
        const b = boundary();
        const id = buildHomeHubArtifactIdV1(accountId);
        const row = { artifactId: id, header: { v: 1, kind: HOME_HUB_ARTIFACT_KIND_V1 }, body, revision: { headerVersion: 1, bodyVersion: 1 } };
        b.rows.set(id, row);
        const port = createHomeHubArtifactPortV1(b.transport, { accountId });
        expect(await port.read()).toEqual(HOME_HUB_DEFAULT_LAYOUT);
        expect(b.rows.get(id)).toBe(row);
        expect(b.updates).toEqual([]);
        expect((await port.apply({ kind: 'reset' })).layout).toEqual(HOME_HUB_DEFAULT_LAYOUT);
    });

    it('drops nested stored extras, writes canonical content, and retains strict widget inputs', async () => {
        const b = boundary();
        const id = buildHomeHubArtifactIdV1(accountId);
        const instance = copy('one', 'A');
        const storedInstance = { ...instance, obsolete: true, definition: { ...instance.definition, obsolete: true,
            surface: { ...instance.definition.surface, obsolete: true } }, bindings: {
            session: { ...instance.bindings.session, obsolete: true },
        } };
        const seed = (instances: readonly unknown[]) => b.rows.set(id, {
            artifactId: id, header: { v: 1, kind: HOME_HUB_ARTIFACT_KIND_V1 },
            body: JSON.stringify({ v: 1, instances, order: ['one'], sections: { one: { frameStyle: 'plain', obsolete: true } }, obsolete: true }),
            revision: { headerVersion: 1, bodyVersion: 1 },
        });
        const port = createHomeHubArtifactPortV1(b.transport, { accountId });
        seed([storedInstance]);
        const known = { ...HOME_HUB_DEFAULT_LAYOUT, instances: [instance], order: ['one'], sections: { one: { frameStyle: 'plain' } } };
        expect(await port.read()).toEqual(known);
        await expect(port.apply({ kind: 'widget_add', instance: storedInstance })).rejects.toBeInstanceOf(z.ZodError);
        expect(b.updates).toEqual([]);
        const edited = (await port.apply({ kind: 'widget_rename', instanceId: 'one', displayName: 'Renamed' })).layout;
        expect(edited.instances).toEqual([{ ...instance, displayName: 'Renamed' }]);
        expect(JSON.parse(String(b.rows.get(id)?.body))).toEqual(edited);
        expect(await port.read()).toEqual(edited);
        const { id: _missing, ...withoutIdentity } = storedInstance;
        seed([withoutIdentity]);
        expect(await port.read()).toEqual(HOME_HUB_DEFAULT_LAYOUT);
        seed([instance, instance]);
        expect(await port.read()).toEqual(HOME_HUB_DEFAULT_LAYOUT);
    });

    it('projects stable defaults without writes, then materializes them once on the first setup/layout edit', async () => {
        const b = boundary();
        const port = createHomeHubArtifactPortV1(b.transport, { accountId, readWidgets: () => [shown] });
        const projected = await port.describe(await port.read());
        expect(projected.sections.filter(section => section.kind === 'widget').map(section => section.id)).toEqual([homeHubDefaultWidgetInstanceId(shown.key)]);
        expect(b.rows.size).toBe(0);
        const first = (await port.apply({ kind: 'setup_visibility', stepId: 'addPhone', hidden: true })).layout;
        expect(first.instances.map(instance => instance.id)).toEqual([homeHubDefaultWidgetInstanceId(shown.key)]);
        const second = (await port.apply({ kind: 'frameStyle', sectionId: first.instances[0]!.id, frameStyle: 'plain' })).layout;
        expect(second.instances).toHaveLength(1);
        expect(second.hidden).toContain('setup:addPhone');
        expect(second.hidden).toContain('machines');
        expect(b.rows.size).toBe(1);
        const reload = createHomeHubArtifactPortV1(b.transport, { accountId, readWidgets: () => [shown] });
        expect(await reload.read()).toEqual(second);
    });

    it('replays setup and independently configured copies across competing create and CAS winners', async () => {
        const b = boundary();
        const port = createHomeHubArtifactPortV1(b.transport, { accountId });
        await Promise.all([
            port.apply({ kind: 'widget_add', instance: copy('one', 'A') }),
            port.apply({ kind: 'widget_add', instance: copy('two', 'B') }),
            port.apply({ kind: 'setup_visibility', stepId: 'addMachine', hidden: true }),
        ]);
        await Promise.all([
            port.apply({ kind: 'widget_inputs', instanceId: 'one', bindings: { session: { kind: 'value', value: 'C' } } }),
            port.apply({ kind: 'widget_width', instanceId: 'two', width: 'full' }),
        ]);
        const layout = await port.read();
        expect(layout.instances).toEqual(expect.arrayContaining([copy('one', 'C'), copy('two', 'B')]));
        expect(layout.hidden).toContain('setup:addMachine');
        expect(layout.sections?.two?.width).toBe('full');
        expect(b.rows.size).toBe(1);
        await port.apply({ kind: 'widget_remove', instanceId: 'one' });
        expect((await port.read()).instances).toEqual([copy('two', 'B')]);
    });

    it('rejects guarded removal on the CAS replay winner when another edit changed the instance', async () => {
        const b = boundary();
        const otherClient = createHomeHubArtifactPortV1(b.transport, { accountId });
        const expectedInstance = copy('one', 'A');
        await otherClient.apply({ kind: 'widget_add', instance: expectedInstance });
        await otherClient.apply({ kind: 'widget_add', instance: copy('two', 'B') });
        await otherClient.apply({ kind: 'widget_width', instanceId: 'one', width: 'full' });
        await otherClient.apply({ kind: 'setup_visibility', stepId: 'addPhone', hidden: true });
        let compete = true;
        // The genuine persistence boundary admits another client's write after our read,
        // so the real Artifact port must replay its semantic removal on the new CAS winner.
        const port = createHomeHubArtifactPortV1({ ...b.transport, update: async input => {
            if (compete) {
                compete = false;
                await otherClient.apply({ kind: 'widget_inputs', instanceId: 'one', bindings: copy('one', 'C').bindings });
            }
            return b.transport.update(input);
        } }, { accountId });
        const intent = { kind: 'widget_remove' as const, instanceId: 'one', expectedInstance };
        await expect(port.apply(intent)).rejects.toMatchObject({ code: 'widget_instance_changed' });
        expect(compete).toBe(false);
        const retained = await otherClient.read();
        expect(retained.instances).toEqual([copy('one', 'C'), copy('two', 'B')]);
        expect(retained.sections?.one?.width).toBe('full');
        expect(retained.hidden).toContain('setup:addPhone');
    });

    it('removes an unchanged guarded instance independent of JSON key order and retains ordinary removal', async () => {
        const b = boundary();
        const port = createHomeHubArtifactPortV1(b.transport, { accountId });
        const instance = { ...copy('one', 'A'), bindings: { filters: { kind: 'value' as const, value: { a: 1, b: 2 } } } };
        await port.apply({ kind: 'widget_add', instance });
        await port.apply({ kind: 'widget_add', instance: copy('two', 'B') });
        const intent = { kind: 'widget_remove' as const, instanceId: 'one', expectedInstance: {
            ...instance, bindings: { filters: { kind: 'value' as const, value: { b: 2, a: 1 } } },
        } };
        const revision = [...b.rows.values()][0]!.revision;
        await port.apply({ kind: 'widget_inputs', instanceId: 'one', bindings: intent.expectedInstance.bindings });
        expect([...b.rows.values()][0]!.revision).toEqual(revision);
        await port.apply(intent);
        expect((await port.read()).instances).toEqual([copy('two', 'B')]);
        await port.apply({ kind: 'widget_inputs', instanceId: 'two', bindings: copy('two', 'C').bindings });
        await port.apply({ kind: 'widget_remove', instanceId: 'two' });
        expect((await port.read()).instances).toEqual([]);
    });

    it.each(['frame', 'order'] as const)('rejects guarded removal after a concurrent %s-only placement edit wins CAS', async edit => {
        const b = boundary();
        const otherClient = createHomeHubArtifactPortV1(b.transport, { accountId });
        const expectedInstance = copy('one', 'A');
        const added = (await otherClient.apply({ kind: 'widget_add', instance: expectedInstance })).layout;
        await otherClient.apply({ kind: 'widget_add', instance: copy('two', 'B') });
        const expectedPresentation = { width: 'half' as const, frameStyle: null, nativeIndex: added.order.indexOf('one') };
        let compete = true;
        const port = createHomeHubArtifactPortV1({ ...b.transport, update: async input => {
            if (compete) {
                compete = false;
                await otherClient.apply(edit === 'frame'
                    ? { kind: 'frameStyle', sectionId: 'one', frameStyle: 'card' }
                    : { kind: 'move_to', sectionId: 'one', position: { anchorId: 'start', placement: 'before' } });
            }
            return b.transport.update(input);
        } }, { accountId });
        const intent = { kind: 'widget_remove' as const, instanceId: 'one', expectedInstance, expectedPresentation };
        await expect(port.apply(intent)).rejects.toMatchObject({ code: 'widget_placement_changed' });
        expect(compete).toBe(false);
        const retained = await otherClient.read();
        expect(retained.instances).toEqual([expectedInstance, copy('two', 'B')]);
        if (edit === 'frame') expect(retained.sections?.one?.frameStyle).toBe('card');
        else expect(retained.order.indexOf('one')).toBe(0);
    });

    it('adds width and frame atomically, then removes an unchanged presentation-guarded instance', async () => {
        const b = boundary();
        const port = createHomeHubArtifactPortV1(b.transport, { accountId });
        const instance = copy('one', 'A');
        const intent = { kind: 'widget_add' as const, instance, width: 'full' as const, frameStyle: 'plain' as const,
            position: { anchorId: 'setup', placement: 'before' as const } };
        const added = (await port.apply(intent)).layout;
        expect(added.sections?.one).toEqual({ width: 'full', frameStyle: 'plain' });
        expect(added.order.indexOf('one')).toBe(added.order.indexOf('setup') - 1);
        // The committed add already carries presentation; persistence received no later patch.
        expect([...b.rows.values()].map(row => typeof row.body === 'string' ? JSON.parse(row.body).sections.one : null))
            .toEqual([{ width: 'full', frameStyle: 'plain' }]);
        expect(b.updates).toEqual([]);
        const remove = { kind: 'widget_remove' as const, instanceId: 'one', expectedInstance: instance,
            expectedPresentation: { width: 'full' as const, frameStyle: 'plain' as const, nativeIndex: added.order.indexOf('one') } };
        await port.apply(remove);
        expect((await port.read()).instances).toEqual([]);
    });

    it('refuses guarded cleanup when a concurrent Artifact visibility edit wins CAS', async () => {
        const b = boundary();
        const otherClient = createHomeHubArtifactPortV1(b.transport, { accountId });
        const instance = copy('one', 'A');
        const added = (await otherClient.apply({ kind: 'widget_add', instance })).layout;
        let compete = true;
        const port = createHomeHubArtifactPortV1({ ...b.transport, update: async input => {
            if (compete) {
                compete = false;
                // A concurrent Account Artifact editor retains the instance but changes
                // its persisted visibility; the real transport supplies the CAS conflict.
                const row = await b.transport.read(input.artifactId);
                if (!row || typeof row.body !== 'string') throw new Error('Expected existing Home Artifact');
                const layout = JSON.parse(row.body);
                await b.transport.update({ artifactId: row.artifactId, expectedRevision: row.revision,
                    header: row.header, body: JSON.stringify({ ...layout, hidden: [...layout.hidden, instance.id] }) });
            }
            return b.transport.update(input);
        } }, { accountId });
        const intent = { kind: 'widget_remove' as const, instanceId: instance.id, expectedInstance: instance,
            expectedPresentation: { width: 'half' as const, frameStyle: null, nativeIndex: added.order.indexOf(instance.id), hidden: false } };
        await expect(port.apply(intent)).rejects.toMatchObject({ code: 'widget_placement_changed' });
        expect(compete).toBe(false);
        const retained = await otherClient.read();
        expect(retained.instances).toEqual([instance]);
        expect(retained.hidden).toContain(instance.id);
        await otherClient.apply({ kind: 'widget_remove', instanceId: instance.id });
        expect((await otherClient.read()).instances).toEqual([]);
    });

    it('adds and moves at native indices across builtin and unresolved order slots', async () => {
        const b = boundary();
        const artifactId = buildHomeHubArtifactIdV1(accountId);
        b.rows.set(artifactId, { artifactId, header: { v: 1, kind: HOME_HUB_ARTIFACT_KIND_V1 },
            body: JSON.stringify({ ...HOME_HUB_DEFAULT_LAYOUT, order: ['unresolved', 'setup'], instances: [copy('one', 'A')] }),
            revision: { headerVersion: 1, bodyVersion: 1 } });
        const port = createHomeHubArtifactPortV1(b.transport, { accountId });
        const added = (await port.apply({ kind: 'widget_add', instance: copy('two', 'B'),
            width: 'full', frameStyle: 'plain', position: { nativeIndex: 1 } })).layout;
        expect(added.order.slice(0, 4)).toEqual(['unresolved', 'two', 'setup', 'start']);
        expect(added.sections?.two).toEqual({ width: 'full', frameStyle: 'plain' });
        await port.apply({ kind: 'move_to', sectionId: 'one', position: { nativeIndex: 0 } });
        const moved = (await port.apply({ kind: 'move_to', sectionId: 'setup', position: { nativeIndex: 2 } })).layout;
        expect(moved.order.slice(0, 5)).toEqual(['one', 'unresolved', 'setup', 'two', 'start']);
        expect(moved.instances).toEqual([copy('one', 'A'), copy('two', 'B')]);
        expect(moved.sections?.two).toEqual({ width: 'full', frameStyle: 'plain' });
        await expect(port.apply({ kind: 'move_to', sectionId: 'unresolved', position: { nativeIndex: 0 } }))
            .rejects.toMatchObject({ code: 'home_hub_section_not_found' });
        expect((await port.read()).order).toEqual(moved.order);
        await expect(port.apply({ kind: 'move_to', sectionId: 'one',
            position: { nativeIndex: 0, anchorId: 'start', placement: 'before' } }))
            .rejects.toBeInstanceOf(z.ZodError);
    });

    it('guards a default-projected source against the canonical full order without materializing a second copy', async () => {
        const b = boundary();
        const artifactId = buildHomeHubArtifactIdV1(accountId);
        b.rows.set(artifactId, { artifactId, header: { v: 1, kind: HOME_HUB_ARTIFACT_KIND_V1 },
            body: JSON.stringify({ ...HOME_HUB_DEFAULT_LAYOUT, order: ['unresolved'] }), revision: { headerVersion: 1, bodyVersion: 1 } });
        const port = createHomeHubArtifactPortV1(b.transport, { accountId, readWidgets: () => [shown] });
        const sparse = await port.read();
        const projected = await port.describe(sparse);
        const section = projected.sections.find(section => section.kind === 'widget');
        if (section?.kind !== 'widget') throw new Error('Expected default-shown widget');
        const expectedPresentation = await port.captureWidgetPresentation(sparse, section.id);
        expect(expectedPresentation).toEqual({ width: 'half', frameStyle: null, hidden: false,
            nativeIndex: projected.sections.indexOf(section) + 1 });
        expect(sparse.order).toEqual(['unresolved']);
        expect(sparse.instances).toEqual([]);
        expect(b.updates).toEqual([]);
        const intent = { kind: 'widget_remove' as const, instanceId: section.id, expectedInstance: section.instance,
            expectedPresentation };
        await port.apply(intent);
        const reloaded = await port.read();
        expect(reloaded.instances).toEqual([]);
        expect(reloaded.order).toContain('unresolved');
        expect(reloaded.hidden).toContain(section.id);
        expect((await port.describe(reloaded)).sections.some(candidate => candidate.id === section.id)).toBe(false);
        expect(b.rows.size).toBe(1);
    });

    it('uses distinct valid Artifact UUIDs for Accounts and refuses substituted ownership and unreadable records', async () => {
        const b = boundary();
        const id = buildHomeHubArtifactIdV1(accountId);
        expect(z.string().uuid().parse(id)).toBe(id);
        expect(buildHomeHubArtifactIdV1('account-two')).not.toBe(id);
        b.rows.set(id, { artifactId: id, header: { v: 1, kind: 'another-kind' }, body: JSON.stringify(HOME_HUB_DEFAULT_LAYOUT), revision: { headerVersion: 1, bodyVersion: 1 } });
        const port = createHomeHubArtifactPortV1(b.transport, { accountId });
        await expect(port.read()).rejects.toMatchObject({ code: 'invalid_home_hub_record' });
        await expect(port.apply({ kind: 'reset' })).rejects.toMatchObject({ code: 'invalid_home_hub_record' });
        const other = createHomeHubArtifactPortV1({ ...b.transport, read: async () => ({ ...b.rows.get(id)!, ownerAccountId: 'other' }) }, { accountId });
        await expect(other.read()).rejects.toMatchObject({ code: 'home_hub_account_mismatch' });
        expect(b.updates).toEqual([]);
    });

    it('fails closed on transport mode refusal and Account retirement without replacing the stored bytes', async () => {
        const b = boundary();
        const id = buildHomeHubArtifactIdV1(accountId);
        const row = { artifactId: id, header: { v: 1, kind: HOME_HUB_ARTIFACT_KIND_V1 }, body: JSON.stringify(HOME_HUB_DEFAULT_LAYOUT), revision: { headerVersion: 1, bodyVersion: 1 } };
        b.rows.set(id, row);
        const refused = createHomeHubArtifactPortV1({ ...b.transport, read: async () => { throw Object.assign(new Error('artifact_account_mode_mismatch'), { code: 'artifact_account_mode_mismatch' }); } }, { accountId });
        await expect(refused.read()).rejects.toMatchObject({ code: 'artifact_account_mode_mismatch' });
        await expect(refused.apply({ kind: 'setup_visibility', stepId: 'x', hidden: true })).rejects.toMatchObject({ code: 'artifact_account_mode_mismatch' });
        let current = true;
        const retired = createHomeHubArtifactPortV1({ ...b.transport, read: async (...args) => { const result = await b.transport.read(...args); current = false; return result; } }, { accountId, shouldContinue: () => current });
        await expect(retired.apply({ kind: 'reset' })).rejects.toMatchObject({ code: 'home_hub_scope_retired' });
        expect(b.rows.get(id)).toBe(row);
        expect(b.updates).toEqual([]);
    });

    it('returns the acknowledged first create after Account retirement without a late read or publication', async () => {
        const b = boundary();
        let current = true;
        const published: unknown[] = [];
        const port = createHomeHubArtifactPortV1({ ...b.transport, create: async input => {
            const result = await b.transport.create(input);
            current = false;
            return result;
        } }, { accountId, shouldContinue: () => current, onLayout: layout => { published.push(layout); } });
        const acknowledged = (await port.apply({ kind: 'setup_visibility', stepId: 'addPhone', hidden: true })).layout;
        expect(acknowledged.hidden).toContain('setup:addPhone');
        expect(published).toEqual([]);
        expect(b.reads).toEqual([buildHomeHubArtifactIdV1(accountId)]);
        expect(await createHomeHubArtifactPortV1(b.transport, { accountId }).read()).toEqual(acknowledged);
        await expect(port.apply({ kind: 'reset' })).rejects.toMatchObject({ code: 'home_hub_scope_retired' });
    });

    it('replays against the actual same-id create acknowledgement rather than the attempted content', async () => {
        const b = boundary();
        const id = buildHomeHubArtifactIdV1(accountId);
        let incumbent = true;
        const port = createHomeHubArtifactPortV1({ ...b.transport, create: async input => {
            if (incumbent) {
                incumbent = false;
                b.rows.set(id, { artifactId: id, header: input.header,
                    body: JSON.stringify({ ...HOME_HUB_DEFAULT_LAYOUT, hidden: ['setup:addMachine'] }),
                    revision: { headerVersion: 3, bodyVersion: 4 } });
            }
            return b.transport.create(input);
        } }, { accountId });
        const acknowledged = (await port.apply({ kind: 'setup_visibility', stepId: 'addPhone', hidden: true })).layout;
        expect(acknowledged.hidden).toEqual(expect.arrayContaining(['setup:addMachine', 'setup:addPhone']));
        expect(b.rows.get(id)?.revision).toEqual({ headerVersion: 4, bodyVersion: 5 });
        expect(b.updates).toEqual([id]);
    });

    it('returns the acknowledged update after Account retirement without publishing its late layout', async () => {
        const b = boundary();
        const id = buildHomeHubArtifactIdV1(accountId);
        b.rows.set(id, { artifactId: id, header: { v: 1, kind: HOME_HUB_ARTIFACT_KIND_V1 },
            body: JSON.stringify(HOME_HUB_DEFAULT_LAYOUT), revision: { headerVersion: 1, bodyVersion: 1 } });
        let current = true;
        const published: unknown[] = [];
        const port = createHomeHubArtifactPortV1({ ...b.transport, update: async input => {
            const result = await b.transport.update(input);
            current = false;
            return result;
        } }, { accountId, shouldContinue: () => current, onLayout: layout => { published.push(layout); } });
        const acknowledged = (await port.apply({ kind: 'setup_visibility', stepId: 'addPhone', hidden: true })).layout;
        expect(acknowledged.hidden).toContain('setup:addPhone');
        expect(published).toEqual([]);
        expect(await createHomeHubArtifactPortV1(b.transport, { accountId }).read()).toEqual(acknowledged);
        await expect(port.apply({ kind: 'reset' })).rejects.toMatchObject({ code: 'home_hub_scope_retired' });
        expect(b.updates).toEqual([id]);
    });

    it('preserves an acknowledged update refusal when the Account retires while awaiting it', async () => {
        const b = boundary();
        const id = buildHomeHubArtifactIdV1(accountId);
        const row = { artifactId: id, header: { v: 1, kind: HOME_HUB_ARTIFACT_KIND_V1 },
            body: JSON.stringify(HOME_HUB_DEFAULT_LAYOUT), revision: { headerVersion: 1, bodyVersion: 1 } };
        b.rows.set(id, row);
        let current = true;
        // The Account Artifact transport is the authoritative mode-admission boundary.
        const port = createHomeHubArtifactPortV1({ ...b.transport, update: async () => {
            current = false;
            return { ok: false, errorCode: 'artifact_account_mode_mismatch', error: 'artifact_account_mode_mismatch' };
        } }, { accountId, shouldContinue: () => current });
        await expect(port.apply({ kind: 'setup_visibility', stepId: 'addPhone', hidden: true }))
            .rejects.toMatchObject({ code: 'artifact_account_mode_mismatch' });
        expect(b.rows.get(id)).toBe(row);
        expect(b.updates).toEqual([]);
    });
});
