import type { PluginCancellationOptions, Disposable } from '../lifecycle.js';
import type { PluginDiagnosticData } from '../diagnostics.js';
import type { JsonValue, PluginReference } from '../identity.js';

export type PluginUiPlacement =
    | 'session.details' | 'session.preview' | 'session.tool' | 'session.side' | 'session.rightSidebarTab'
    | 'workspace.details' | 'workspace.main'
    | 'project.details' | 'project.main' | 'project.rightSidebarTab'
    | 'app.settingsPage' | 'app.sidePanel' | 'app.bottomPanel' | 'app.rightSidebarTab'
    | 'browser.panel' | 'services.panel';

export type PluginUiSurfaceContext = Readonly<{
    placement: PluginUiPlacement;
    platform: 'web' | 'ios' | 'android' | 'desktop';
    locale: string;
    direction: 'ltr' | 'rtl';
    colorScheme: 'light' | 'dark';
    contrast: 'normal' | 'high';
    textScale: number;
    reducedMotion: boolean;
    screenReaderEnabled: boolean;
    safeAreaInsets: Readonly<{ top: number; right: number; bottom: number; left: number }>;
    session?: Readonly<{ id: string; agentId?: string; state?: string }>;
    project?: Readonly<{ id: string; machineId: string }>;
    browser?: Readonly<{ targetId: string; origin?: string }>;
}>;

export type PluginUiHostApiVersion = Readonly<{
    apiVersion: string;
    wireVersion: number;
    methods: readonly PluginUiHostMethod[];
}>;

export type PluginUiResource = Readonly<{
    contentType: string;
    digest: string;
    bytes: Uint8Array;
}>;

export interface PluginUiHostApi {
    version(): PluginUiHostApiVersion;
    context(options?: PluginCancellationOptions): Promise<PluginUiSurfaceContext>;
    watchContext(listener: (context: PluginUiSurfaceContext) => void): Disposable;
    executeAction(action: PluginReference, input: JsonValue, options?: PluginCancellationOptions): Promise<JsonValue>;
    readResource(resource: PluginReference, options?: PluginCancellationOptions): Promise<PluginUiResource>;
    watchResource(resource: PluginReference, listener: (event: Readonly<{ digest: string }>) => void): Disposable;
    openSurface(view: PluginReference, input?: JsonValue, options?: PluginCancellationOptions): Promise<void>;
    diagnostic(data: PluginDiagnosticData): void;
    readClipboard(options?: PluginCancellationOptions): Promise<string>;
    writeClipboard(value: string, options?: PluginCancellationOptions): Promise<void>;
    openExternalLink(url: string, options?: PluginCancellationOptions): Promise<void>;
}

export type PluginUiHostMethod = Exclude<keyof PluginUiHostApi, 'version'>;

export interface PluginUiRenderContext {
    readonly plugin: Readonly<{ id: string; version: string }>;
    readonly view: Readonly<{ id: string; placement: PluginUiPlacement }>;
    readonly surface: PluginUiSurfaceContext;
    readonly hostApi: PluginUiHostApi;
    readonly signal: AbortSignal;
}

export type PluginUiRenderElement = Readonly<{ type: unknown; props: unknown; key: string | null }>;
export type PluginUiRenderSurface = (context: PluginUiRenderContext) => PluginUiRenderElement | null;
