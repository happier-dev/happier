import type { BrowserRenderEngineKindV1 } from '@happier-dev/protocol';

import type { BrowserAdapterUnavailableReasonCode } from './availability';

export type DesktopWebViewNativePlatform =
    | 'macos'
    | 'windows'
    | 'linuxX11'
    | 'linuxWayland'
    | 'linuxUnknown'
    | 'unsupported';

export type DesktopWebViewNativePrimitive =
    | 'macosNsViewWebKit'
    | 'windowsHwndWebView2'
    | 'linuxX11ChildEmbedding'
    | 'linuxWaylandGtkEmbedding'
    | 'disabled';

export type DesktopWebViewNativeProducer = 'tauriWryNativeChildView' | 'none';

/**
 * SB-E: the desktop-webview native disabled reasons are a strict subset of the adapter-level
 * `BrowserAdapterUnavailableReasonCode` union — they are the same reason travelling from the Rust
 * host through the bridge to the adapter selector. They used to be written out three times (this
 * union, the adapter union in `availability.ts`, and the runtime `Set` below) with no reference
 * between them, so renaming a code in one place silently left the others behind.
 *
 * This tuple is now the single place the subset is written. `satisfies` ties it to the adapter
 * union, so renaming a code there without renaming it here is a compile error rather than a
 * mismatch that only shows up as an unrecognised reason at runtime; and the type and the runtime
 * membership check below are both derived from it, so they cannot drift from each other.
 */
const DESKTOP_WEBVIEW_NATIVE_DISABLED_REASON_CODES = [
    'tauri_host_unavailable',
    'desktop_webview_native_command_unavailable',
    'desktop_webview_native_contract_invalid',
    'desktop_webview_child_view_unimplemented',
    'desktop_webview_x11_child_unimplemented',
    'desktop_webview_wayland_gtk_unimplemented',
    'desktop_webview_linux_display_unavailable',
    'desktop_webview_unsupported_platform',
] as const satisfies readonly BrowserAdapterUnavailableReasonCode[];

export type DesktopWebViewNativeDisabledReason = Extract<
    BrowserAdapterUnavailableReasonCode,
    (typeof DESKTOP_WEBVIEW_NATIVE_DISABLED_REASON_CODES)[number]
>;

const DESKTOP_WEBVIEW_NATIVE_PLATFORMS = new Set<string>([
    'macos',
    'windows',
    'linuxX11',
    'linuxWayland',
    'linuxUnknown',
    'unsupported',
]);

const DESKTOP_WEBVIEW_NATIVE_PRIMITIVES = new Set<string>([
    'macosNsViewWebKit',
    'windowsHwndWebView2',
    'linuxX11ChildEmbedding',
    'linuxWaylandGtkEmbedding',
    'disabled',
]);

const DESKTOP_WEBVIEW_NATIVE_DISABLED_REASONS: ReadonlySet<string> =
    new Set(DESKTOP_WEBVIEW_NATIVE_DISABLED_REASON_CODES);

export type DesktopWebViewSupport = Readonly<{
    navigation: boolean;
    goBackForward: boolean;
    reload: boolean;
    stop: boolean;
    pageInfoDiagnostics: boolean;
    nativeDevtools: boolean;
    capture: boolean;
    recording: boolean;
    automation: boolean;
}>;

const DISABLED_DESKTOP_WEBVIEW_SUPPORT: DesktopWebViewSupport = {
    navigation: false,
    goBackForward: false,
    reload: false,
    stop: false,
    pageInfoDiagnostics: false,
    nativeDevtools: false,
    capture: false,
    recording: false,
    automation: false,
};

export type DesktopWebViewNativeAvailability = Readonly<{
    available: boolean;
    platform: DesktopWebViewNativePlatform;
    primitive: DesktopWebViewNativePrimitive;
    renderEngine: BrowserRenderEngineKindV1;
    producer: DesktopWebViewNativeProducer;
    privilegedIpc: boolean;
    supports: DesktopWebViewSupport;
    disabledReasons: readonly DesktopWebViewNativeDisabledReason[];
}>;

export function unavailableDesktopWebViewNativeAvailability(
    reason: DesktopWebViewNativeDisabledReason,
    input: Partial<Pick<DesktopWebViewNativeAvailability, 'platform' | 'primitive'>> = {},
): DesktopWebViewNativeAvailability {
    return {
        available: false,
        platform: input.platform ?? 'unsupported',
        primitive: input.primitive ?? 'disabled',
        renderEngine: 'unavailable',
        producer: 'none',
        privilegedIpc: false,
        supports: DISABLED_DESKTOP_WEBVIEW_SUPPORT,
        disabledReasons: [reason],
    };
}

function isBoolean(value: unknown): value is boolean {
    return typeof value === 'boolean';
}

function normalizeSupport(value: unknown): DesktopWebViewSupport | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }
    const record = value as Readonly<Record<keyof DesktopWebViewSupport, unknown>>;
    const support = {
        navigation: record.navigation,
        goBackForward: record.goBackForward,
        reload: record.reload,
        stop: record.stop,
        pageInfoDiagnostics: record.pageInfoDiagnostics,
        nativeDevtools: record.nativeDevtools,
        capture: record.capture,
        recording: record.recording,
        automation: record.automation,
    };
    return Object.values(support).every(isBoolean)
        ? support as DesktopWebViewSupport
        : null;
}

function platformMatchesPrimitive(
    platform: DesktopWebViewNativePlatform,
    primitive: DesktopWebViewNativePrimitive,
): boolean {
    switch (platform) {
        case 'macos':
            return primitive === 'macosNsViewWebKit';
        case 'windows':
            return primitive === 'windowsHwndWebView2';
        case 'linuxX11':
            return primitive === 'linuxX11ChildEmbedding';
        case 'linuxWayland':
            return primitive === 'linuxWaylandGtkEmbedding';
        case 'linuxUnknown':
        case 'unsupported':
            return primitive === 'disabled';
    }
}

function availableSupportMatchesNativeContract(
    platform: DesktopWebViewNativePlatform,
    support: DesktopWebViewSupport,
): boolean {
    if (platform === 'linuxWayland' || platform === 'linuxUnknown' || platform === 'unsupported') {
        return false;
    }
    if (support.capture && platform !== 'macos') {
        return false;
    }
    return support.navigation === true
        && support.recording === false
        && support.automation === false;
}

function readString(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value : null;
}

function readPlatform(value: unknown): DesktopWebViewNativePlatform | null {
    const platform = readString(value);
    return platform && DESKTOP_WEBVIEW_NATIVE_PLATFORMS.has(platform)
        ? platform as DesktopWebViewNativePlatform
        : null;
}

function readPrimitive(value: unknown): DesktopWebViewNativePrimitive | null {
    const primitive = readString(value);
    return primitive && DESKTOP_WEBVIEW_NATIVE_PRIMITIVES.has(primitive)
        ? primitive as DesktopWebViewNativePrimitive
        : null;
}

function readDisabledReason(value: unknown): DesktopWebViewNativeDisabledReason | null {
    const reason = readString(value);
    return reason && DESKTOP_WEBVIEW_NATIVE_DISABLED_REASONS.has(reason)
        ? reason as DesktopWebViewNativeDisabledReason
        : null;
}

export function normalizeDesktopWebViewNativeAvailability(
    payload: unknown,
): DesktopWebViewNativeAvailability {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return unavailableDesktopWebViewNativeAvailability('desktop_webview_native_contract_invalid');
    }

    const record = payload as Readonly<Record<string, unknown>>;
    const available = record.available === true;
    const platform = readPlatform(record.platform);
    const primitive = readPrimitive(record.primitive);
    const support = normalizeSupport(record.supports);
    const disabledReasons = Array.isArray(record.disabledReasons)
        ? record.disabledReasons.map(readDisabledReason).filter((reason): reason is DesktopWebViewNativeDisabledReason => reason != null)
        : [];

    if (!platform || !primitive || !support || typeof record.privilegedIpc !== 'boolean') {
        return unavailableDesktopWebViewNativeAvailability('desktop_webview_native_contract_invalid');
    }

    if (available) {
        if (
            record.renderEngine !== 'desktopWebView'
            || record.producer !== 'tauriWryNativeChildView'
            || record.privilegedIpc !== false
            || !platformMatchesPrimitive(platform, primitive)
            || !availableSupportMatchesNativeContract(platform, support)
        ) {
            return unavailableDesktopWebViewNativeAvailability('desktop_webview_native_contract_invalid', {
                platform,
                primitive,
            });
        }
        return {
            available: true,
            platform,
            primitive,
            renderEngine: 'desktopWebView',
            producer: 'tauriWryNativeChildView',
            privilegedIpc: false,
            supports: support,
            disabledReasons: [],
        };
    }

    return {
        available: false,
        platform,
        primitive,
        renderEngine: 'unavailable',
        producer: 'none',
        privilegedIpc: false,
        supports: DISABLED_DESKTOP_WEBVIEW_SUPPORT,
        disabledReasons: disabledReasons.length > 0
            ? disabledReasons
            : ['desktop_webview_native_contract_invalid'],
    };
}

export function desktopWebViewAvailabilitySupportsBrowsing(
    availability: DesktopWebViewNativeAvailability | null | undefined,
): availability is DesktopWebViewNativeAvailability & Readonly<{
    available: true;
    renderEngine: 'desktopWebView';
    producer: 'tauriWryNativeChildView';
    privilegedIpc: false;
}> {
    return availability?.available === true
        && availability.renderEngine === 'desktopWebView'
        && availability.producer === 'tauriWryNativeChildView'
        && availability.privilegedIpc === false
        && availability.supports.navigation === true;
}
