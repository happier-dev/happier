import { Platform } from 'react-native';

import {
    DaemonHostedWebFrameCapabilityV1Schema,
    type DaemonHostedWebFrameCapabilityV1,
} from '@happier-dev/protocol';

import { readDesktopWebViewNativeAvailability } from '@/sync/domains/browser/adapters/desktopWebViewBridge';
import { isTauriDesktop } from '@/utils/platform/tauri';

function exactCapability(value: unknown): DaemonHostedWebFrameCapabilityV1 | null {
    const parsed = DaemonHostedWebFrameCapabilityV1Schema.safeParse(value);
    return parsed.success ? Object.freeze({ ...parsed.data }) : null;
}

/**
 * Reports the one physical hosted-frame adapter the running web shell can
 * actually construct. This publishes a host fact only; Artifact admission,
 * source selection, and renderer fallback remain daemon/registry-owned.
 */
export async function resolveHostedWebFrameCapability(): Promise<DaemonHostedWebFrameCapabilityV1 | null> {
    if (Platform.OS !== 'web') return null;

    // The packaged Tauri host owns a direct Wry child view rather than a DOM
    // iframe. The incumbent native platform fact, rather than Tauri shell
    // detection alone, decides whether that physical Artifact adapter exists.
    if (isTauriDesktop()) {
        const availability = await readDesktopWebViewNativeAvailability();
        return availability.platform === 'macos'
            ? exactCapability({ platform: 'desktop', adapter: 'wry' })
            : null;
    }

    const document = globalThis.document;
    const body = document?.body;
    if (!document || !body || typeof document.createElement !== 'function') return null;

    let frame: HTMLIFrameElement | null = null;
    let attached = false;
    try {
        const candidate = document.createElement('iframe');
        if (
            candidate.nodeName.toLowerCase() !== 'iframe'
            || typeof candidate.setAttribute !== 'function'
            || !('contentWindow' in candidate)
        ) {
            return null;
        }
        candidate.setAttribute('sandbox', '');
        body.appendChild(candidate);
        frame = candidate;
        attached = true;
        if (!candidate.contentWindow) return null;

        return exactCapability({ platform: 'web', adapter: 'domIframe' });
    } catch {
        return null;
    } finally {
        if (attached && frame) {
            try {
                body.removeChild(frame);
            } catch {
                // This is only a best-effort cleanup for the short-lived probe.
            }
        }
    }
}
