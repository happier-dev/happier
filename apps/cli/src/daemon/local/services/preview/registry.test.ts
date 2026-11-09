import { describe, expect, it } from "vitest";
import { localServicePreviewDirectBindingV1 } from '@happier-dev/protocol/local/services/preview/v1';
import { createDeferred } from '@/testkit/async/deferred';

type PreviewRegistryModule = typeof import("./registry");

async function loadPreviewRegistryModule(): Promise<PreviewRegistryModule | null> {
    return import("./registry").catch(() => null);
}

describe("daemon local service preview registry", () => {
    it('publishes a proved end once and retains the exact ended binding without reviving it', async () => {
        const mod = await import('./registry');
        let publications = 0;
        const registry = mod.createLocalServicePreviewRegistry(() => { publications++; });
        const input = {
            previewId: 'managed-preview', machineId: 'machine_123', owner: { kind: 'user', id: 'account_123' },
            target: { scheme: 'http', host: 'localhost', port: 5173 },
            initialPath: { pathname: '/', search: '' }, display: { title: 'Web', addressLabel: 'Web' }, originMode: 'host',
        } as const;
        let current = true;
        const registered = mod.registerLocalServicePreview(registry, input, { isCurrent: () => current });
        if (!registered.ok) throw new Error(registered.reasonCode);
        const binding = localServicePreviewDirectBindingV1(registered.resource);
        const afterRegistration = publications;
        await mod.resolveLocalServicePreviewApplication(registry, binding);
        expect(publications).toBe(afterRegistration);
        current = false;
        await expect(mod.resolveLocalServicePreviewApplication(registry, binding)).rejects.toMatchObject({ reasonCode: 'preview_not_found' });
        expect(mod.listLocalServicePreviewResources(registry)).toEqual([]);
        expect(registry.previewsById.has(binding.previewId)).toBe(true);
        expect(publications).toBe(afterRegistration + 1);
        await expect(mod.resolveLocalServicePreviewApplication(registry, binding)).rejects.toMatchObject({ reasonCode: 'preview_not_found' });
        mod.registerLocalServicePreview(registry, input, { isCurrent: () => true });
        await expect(mod.resolveLocalServicePreviewApplication(registry, binding)).rejects.toMatchObject({ reasonCode: 'preview_not_found' });
        expect(publications).toBe(afterRegistration + 1);
    });

    it.each([false, true] as const)('does not retire a same-binding replacement after a delayed %s observation of its predecessor', async observed => {
        const mod = await import('./registry');
        let publications = 0;
        const registry = mod.createLocalServicePreviewRegistry(() => { publications++; });
        const input = {
            previewId: 'managed-preview', machineId: 'machine_123', owner: { kind: 'user', id: 'account_123' },
            target: { scheme: 'http', host: 'localhost', port: 5173 },
            initialPath: { pathname: '/', search: '' }, display: { title: 'Web', addressLabel: 'Web' }, originMode: 'host',
        } as const;
        const observation = createDeferred<boolean>();
        const registered = mod.registerLocalServicePreview(registry, input, { isCurrent: () => observation.promise });
        if (!registered.ok) throw new Error(registered.reasonCode);
        const resolving = mod.resolveLocalServicePreviewApplication(registry, localServicePreviewDirectBindingV1(registered.resource));
        const replacement = mod.registerLocalServicePreview(registry, input, { isCurrent: () => true });
        if (!replacement.ok) throw new Error(replacement.reasonCode);
        const afterReplacement = publications;
        observation.resolve(observed);
        await expect(resolving).rejects.toMatchObject({ reasonCode: 'preview_not_found' });
        expect(publications).toBe(afterReplacement);
        expect(mod.listLocalServicePreviewResources(registry)).toEqual([replacement.resource]);
        await expect(mod.resolveLocalServicePreviewApplication(registry, localServicePreviewDirectBindingV1(replacement.resource)))
            .resolves.toEqual(replacement.resource);
    });

    it('keeps unknown occurrence evidence live in snapshots and recovers without publishing an end', async () => {
        const mod = await import('./registry');
        let publications = 0;
        let unavailable = true;
        const registry = mod.createLocalServicePreviewRegistry(() => { publications++; });
        const registered = mod.registerLocalServicePreview(registry, {
            previewId: 'managed-preview', machineId: 'machine_123', owner: { kind: 'user', id: 'account_123' },
            target: { scheme: 'http', host: 'localhost', port: 5173 },
            initialPath: { pathname: '/', search: '' }, display: { title: 'Web', addressLabel: 'Web' }, originMode: 'host',
        }, { isCurrent: () => { if (unavailable) throw new Error('native observation unavailable'); return true; } });
        if (!registered.ok) throw new Error(registered.reasonCode);
        const binding = localServicePreviewDirectBindingV1(registered.resource);
        const afterRegistration = publications;
        await expect(mod.resolveLocalServicePreviewApplication(registry, binding)).rejects.toThrow('native observation unavailable');
        expect(mod.listLocalServicePreviewResources(registry)).toEqual([registered.resource]);
        expect(registry.previewsById.get(binding.previewId)?.occurrence?.ended).not.toBe(true);
        unavailable = false;
        await expect(mod.resolveLocalServicePreviewApplication(registry, binding)).resolves.toEqual(registered.resource);
        expect(publications).toBe(afterRegistration);
    });
    it('never lends an occurrence-bound preview to a scanned listener on the same endpoint', async () => {
        const mod = await import('./registry');
        const registry = mod.createLocalServicePreviewRegistry();
        const input = {
            previewId: 'managed-preview', machineId: 'machine_123', owner: { kind: 'user', id: 'account_123' },
            target: { scheme: 'http', host: '127.0.0.1', port: 5173 },
            initialPath: { pathname: '/', search: '' }, display: { title: 'Web', addressLabel: 'localhost:5173' }, originMode: 'host',
        } as const;
        expect(mod.registerLocalServicePreview(registry, { ...input, serviceTarget: {
            kind: 'managed_service', machineId: 'machine_123', managedServiceId: 'retired-instance', cwd: '/repo',
            declaration: { workspaceRefId: 'workspace_123', selection: { kind: 'manifest', name: 'web' } },
        } }).ok).toBe(true);
        const entry = { machineId: 'machine_123', port: 5173, address: { kind: 'loopback', host: '127.0.0.1' } };
        const scanned = { ...entry, address: { ...entry.address, kind: 'loopback' as const, family: 'ipv4' as const },
            id: 'listener', protocol: 'tcp' as const, detectedAt: 1, lastSeenAt: 1, state: 'listening' as const,
            source: 'detected' as const, labels: [], confidence: 'high' as const,
            processOwnershipConfidence: 'high' as const, workspaceAssociationConfidence: 'high' as const, diagnostics: [] };
        expect(mod.selectLocalServicePreviewForInventoryEntry(mod.listLocalServicePreviewResources(registry), scanned, 'account_123')).toBeUndefined();
        expect(mod.registerLocalServicePreview(registry, { ...input, previewId: 'scanned-preview' }).ok).toBe(true);
        expect(mod.selectLocalServicePreviewForInventoryEntry(mod.listLocalServicePreviewResources(registry), scanned, 'account_123')).toBeUndefined();
        const previewId = mod.previewIdForInventoryEntry('account_123', scanned.machineId, undefined, scanned.id);
        expect(mod.registerLocalServicePreview(registry, { ...input, previewId }).ok).toBe(true);
        expect(mod.selectLocalServicePreviewForInventoryEntry(mod.listLocalServicePreviewResources(registry), scanned, 'account_123')?.previewId)
            .toBe(previewId);
        expect(mod.selectLocalServicePreviewForInventoryEntry(mod.listLocalServicePreviewResources(registry), scanned, 'other-account')).toBeUndefined();
        expect(mod.selectLocalServicePreviewForInventoryEntry(mod.listLocalServicePreviewResources(registry), scanned, undefined)).toBeUndefined();
    });
    it("keeps the managed service binding on the browser target it publishes", async () => {
        const mod = await import("./registry");
        const serviceTarget = {
            kind: "managed_service", machineId: "machine_123", managedServiceId: "service_123", cwd: "/repo/web",
            declaration: { workspaceRefId: "workspace_123", selection: { kind: "manifest", name: "web" } },
        } as const;
        const result = mod.registerLocalServicePreview(mod.createLocalServicePreviewRegistry(), {
            previewId: "preview_123", machineId: "machine_123", serviceTarget,
            owner: { kind: "user", id: "account_123" },
            target: { scheme: "http", host: "127.0.0.1", port: 5173 },
            initialPath: { pathname: "/", search: "" },
            display: { title: "Web", addressLabel: "localhost:5173" }, originMode: "host",
        });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.resource.browserTarget?.serviceTarget).toEqual(serviceTarget);
        expect(result.resource.browserTarget?.sessionId).toBeUndefined();
    });

    it("registers preview resources with preserved query and browser target", async () => {
        const mod = await loadPreviewRegistryModule();
        const registry = mod!.createLocalServicePreviewRegistry();

        const result = mod!.registerLocalServicePreview(registry, {
            previewId: "preview_123",
            sessionId: "session_123",
            machineId: "machine_123",
            owner: { kind: "agent", id: "agent_1" },
            target: { scheme: "http", host: "127.0.0.1", port: 5173 },
            initialPath: { pathname: "/dashboard", search: "?tab=preview" },
            display: {
                title: "Kitchen Sink",
                addressLabel: "localhost:5173",
                folderLabel: "happier",
            },
            originMode: "host",
        });

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.resource.initialPath.search).toBe("?tab=preview");
            expect(result.resource.browserTarget).toEqual({
                kind: "localServicePreview",
                targetId: "preview_123",
                sessionId: "session_123",
                machineId: "machine_123",
                display: {
                    title: "Kitchen Sink",
                    addressLabel: "localhost:5173",
                    folderLabel: "happier",
                },
            });
        }
    });

    it("rejects non-loopback preview targets", async () => {
        const mod = await loadPreviewRegistryModule();
        const registry = mod!.createLocalServicePreviewRegistry();

        const result = mod!.registerLocalServicePreview(registry, {
            previewId: "preview_123",
            sessionId: "session_123",
            machineId: "machine_123",
            owner: { kind: "agent", id: "agent_1" },
            target: { scheme: "http", host: "192.168.1.10", port: 5173 },
            initialPath: { pathname: "/", search: "" },
            display: { title: "Kitchen Sink", addressLabel: "192.168.1.10:5173" },
            originMode: "host",
        });

        expect(result).toEqual({ ok: false, reasonCode: "non_loopback_target" });
    });

    it("uses the protocol loopback owner for equivalent IPv4 literal forms", async () => {
        const mod = await loadPreviewRegistryModule();
        const registry = mod!.createLocalServicePreviewRegistry();

        const result = mod!.registerLocalServicePreview(registry, {
            previewId: "preview_integer_loopback",
            sessionId: "session_123",
            machineId: "machine_123",
            owner: { kind: "agent", id: "agent_1" },
            target: { scheme: "http", host: "2130706433", port: 5173 },
            initialPath: { pathname: "/", search: "" },
            display: { title: "Kitchen Sink", addressLabel: "localhost:5173" },
            originMode: "host",
        });

        expect(result.ok).toBe(true);
    });

    it("unregisters resources without clearing unrelated previews", async () => {
        const mod = await loadPreviewRegistryModule();
        const registry = mod!.createLocalServicePreviewRegistry();

        for (const previewId of ["preview_1", "preview_2"]) {
            mod!.registerLocalServicePreview(registry, {
                previewId,
                sessionId: "session_123",
                machineId: "machine_123",
                owner: { kind: "agent", id: "agent_1" },
                target: { scheme: "http", host: "127.0.0.1", port: 5173 },
                initialPath: { pathname: "/", search: "" },
                display: { title: previewId, addressLabel: "localhost:5173" },
                originMode: "host",
            });
        }

        expect(mod!.unregisterLocalServicePreview(registry, "preview_1")).toEqual({ ok: true });
        expect(mod!.listLocalServicePreviewResources(registry).map((resource) => resource.previewId)).toEqual(["preview_2"]);
    });
});
