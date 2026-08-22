import { Platform } from 'react-native';

import {
    DaemonHostedWebFrameCapabilityV1Schema,
    type DaemonHostedWebFrameCapabilityV1,
} from '@happier-dev/protocol';

import { invokeDesktopHost, isDesktopHost } from '@/utils/platform/desktopHost';

function exactCapability(value: unknown): DaemonHostedWebFrameCapabilityV1 | null {
    const parsed = DaemonHostedWebFrameCapabilityV1Schema.safeParse(value);
    return parsed.success ? Object.freeze({ ...parsed.data }) : null;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactlyKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]): boolean {
    const actual = Object.keys(value);
    return actual.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function readNativeHostedArtifactFrameCapability(value: unknown): DaemonHostedWebFrameCapabilityV1 | null {
    if (!isRecord(value) || value.kind !== 'available' || !hasExactlyKeys(value, ['kind', 'capability'])) {
        return null;
    }
    return exactCapability(value.capability);
}

/**
 * Reports the one physical hosted-frame adapter the running web shell can
 * actually construct. This publishes a host fact only; Artifact admission,
 * source selection, and renderer fallback remain daemon/registry-owned.
 */
export async function resolveHostedWebFrameCapability(): Promise<DaemonHostedWebFrameCapabilityV1 | null> {
    if (Platform.OS !== 'web') return null;

    // The packaged Tauri host owns a direct Wry child view rather than a DOM
    // iframe. Its restricted Artifact-native owner, rather than the general
    // browser's profile capability or UI-side OS inference, decides whether
    // this exact physical adapter exists.
    if (isDesktopHost()) {
        try {
            return readNativeHostedArtifactFrameCapability(await invokeDesktopHost<unknown>(
                'desktop_hosted_artifact_get_frame_capability',
            ));
        } catch {
            return null;
        }
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
