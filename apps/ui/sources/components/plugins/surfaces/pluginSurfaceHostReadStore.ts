import { PluginUiHostReadReferenceV1Schema, type PluginUiHostReadReferenceV1 } from '@happier-dev/protocol/plugins/ui/client';
import { pluginUiResourceReferenceKey, type PluginUiResourceEntry, type PluginUiResourceStore } from '@happier-dev/plugin-ui/advanced';
import type { PluginUiResourceSnapshot } from '@happier-dev/plugin-ui/hostApi';

const UNADMITTED: PluginUiResourceSnapshot = Object.freeze({ freshness: 'unknown', pending: 'idle', subscription: 'unsupported' });
const ADMITTING: PluginUiResourceSnapshot = Object.freeze({ freshness: 'unknown', pending: 'initial', subscription: 'establishing' });

/** Permission-only mount facade. Authorized values and all read/watch work stay in the Account store. */
export function createPluginSurfaceHostReadStore(input: Readonly<{
    admit(reference: PluginUiHostReadReferenceV1, signal: AbortSignal): Promise<PluginUiResourceEntry>;
    isCurrent(): boolean;
    lifetimeSignal: AbortSignal;
    declaredStore?: PluginUiResourceStore | null;
}>): PluginUiResourceStore {
    const permissions = new Map<string, Readonly<{ entry: PluginUiResourceEntry; dispose(): void }>>();
    let disposed = false;
    const current = () => !disposed && !input.lifetimeSignal.aborted && input.isCurrent();
    return Object.freeze({
        getEntry(resource) {
            const parsed = PluginUiHostReadReferenceV1Schema.safeParse(resource);
            if (!parsed.success) {
                if (input.declaredStore) return input.declaredStore.getEntry(resource);
                throw Object.assign(new Error('Resource is not declared for this plugin'), { code: 'plugin_resource_not_found' });
            }
            const key = pluginUiResourceReferenceKey(parsed.data, null);
            const existing = permissions.get(key);
            if (existing) return existing.entry;
            let source: PluginUiResourceEntry | null = null;
            let admitted = false;
            let permissionSnapshot = UNADMITTED;
            let admission: Promise<PluginUiResourceEntry | null> | null = null;
            const subscriptions = new Set<{ listener(): void; live: boolean; release?: () => void }>();
            const notify = () => { for (const subscription of [...subscriptions]) subscription.listener(); };
            const refuse = (code: string) => {
                admitted = false;
                source = null;
                if (permissionSnapshot.error?.code !== code) {
                    permissionSnapshot = Object.freeze({ ...UNADMITTED, error: { code, message: code } });
                }
                for (const subscription of subscriptions) { subscription.release?.(); subscription.release = undefined; }
            };
            const ensureAdmission = (): Promise<PluginUiResourceEntry | null> => {
                if (admission) return admission;
                if (!current()) { refuse('plugin_surface_retired'); return Promise.resolve(null); }
                admitted = false;
                permissionSnapshot = ADMITTING;
                admission = input.admit(parsed.data, input.lifetimeSignal).then(entry => {
                    if (!current()) { refuse('plugin_surface_retired'); return null; }
                    source = entry;
                    for (const subscription of subscriptions) {
                        // The Account owner can change its snapshot independently of
                        // this mount's Action settings. Re-admit before disclosure.
                        subscription.release ??= entry.subscribe(() => { void ensureAdmission(); }, subscription.live);
                    }
                    admitted = true;
                    notify();
                    return entry;
                }, error => {
                    refuse(error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
                        ? error.code : 'plugin_resource_unavailable');
                    notify();
                    return null;
                }).finally(() => { admission = null; });
                notify();
                return admission;
            };
            const entry: PluginUiResourceEntry = Object.freeze({
                getSnapshot() {
                    if (!current()) refuse('plugin_surface_retired');
                    return admitted && source ? source.getSnapshot() : permissionSnapshot;
                },
                subscribe(listener, live) {
                    const subscription: { listener(): void; live: boolean; release?: () => void } = { listener, live };
                    subscriptions.add(subscription);
                    // A cached value is not an admission for this new consumer.
                    void ensureAdmission();
                    return () => { subscriptions.delete(subscription); subscription.release?.(); };
                },
                async refresh() {
                    const admitted = await ensureAdmission();
                    if (admitted && current()) await admitted.refresh();
                    return entry.getSnapshot();
                },
            });
            permissions.set(key, { entry, dispose() { refuse('plugin_surface_retired'); notify(); subscriptions.clear(); } });
            return entry;
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            for (const permission of permissions.values()) permission.dispose();
            permissions.clear();
            input.declaredStore?.dispose();
        },
    });
}
