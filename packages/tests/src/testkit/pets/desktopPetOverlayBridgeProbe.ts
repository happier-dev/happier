import type { Page } from '@playwright/test';

export type DesktopPetOverlayBridgeInvocation = Readonly<{
  command: string;
  args?: Record<string, unknown>;
}>;

export const desktopPetOverlayBridgeInvocationKey =
  '__HAPPIER_E2E_DESKTOP_PET_OVERLAY_BRIDGE_INVOCATIONS__' as const;

export type DesktopPetOverlayProbeWindow = Window & {
  __TAURI_INTERNALS__?: {
    invoke?: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
  };
  [desktopPetOverlayBridgeInvocationKey]?: DesktopPetOverlayBridgeInvocation[];
};

type DesktopPetOverlayBridgeProbeOptions = Readonly<{
  windowState?: Readonly<Record<string, unknown>> | null;
}>;

export function createDesktopPetOverlayWindowState(
  params: Readonly<{ sessionId?: string; title?: string }> = {},
): Readonly<Record<string, unknown>> {
  const sessionId = params.sessionId?.trim() || null;
  const status = sessionId ? 'running' : 'idle';
  return {
    activity: {
      state: status,
      reason: status,
      sessionId,
      trayItems: sessionId
        ? [{
            id: `running:${sessionId}:e2e`,
            dismissKey: `running:${sessionId}:e2e`,
            sessionId,
            status,
            priority: 10,
            title: params.title ?? 'Active session',
            subtitle: null,
            activityAtMs: null,
            expiresAtMs: null,
            actions: { open: true, dismiss: true, quickReply: true },
          }]
        : [],
    },
  };
}

export function createDesktopPetOverlayBridgeProbeInitScript(
  options: DesktopPetOverlayBridgeProbeOptions = {},
): (serializedWindowState?: Readonly<Record<string, unknown>> | null) => void {
  const windowState = options.windowState ?? null;
  return (serializedWindowState) => {
    const resolvedWindowState = serializedWindowState === undefined ? windowState : serializedWindowState;
    const invocationKey = '__HAPPIER_E2E_DESKTOP_PET_OVERLAY_BRIDGE_INVOCATIONS__' as const;
    const target = window as DesktopPetOverlayProbeWindow;
    const existingInvoke = target.__TAURI_INTERNALS__?.invoke;
    target[invocationKey] = [];
    target.__TAURI_INTERNALS__ = {
      ...(target.__TAURI_INTERNALS__ ?? {}),
      invoke: async (command: string, args?: Record<string, unknown>) => {
        target[invocationKey]?.push({ command, args });
        if (command === 'desktop_pet_overlay_read_window_state') return resolvedWindowState;
        if (existingInvoke) return existingInvoke(command, args);
        return null;
      },
    };
  };
}

export async function installDesktopPetOverlayBridgeProbe(
  page: Pick<Page, 'addInitScript'>,
  options: DesktopPetOverlayBridgeProbeOptions = {},
): Promise<void> {
  await page.addInitScript(createDesktopPetOverlayBridgeProbeInitScript(options), options.windowState ?? null);
}

export async function readDesktopPetOverlayBridgeInvocations(
  page: Pick<Page, 'evaluate'>,
): Promise<DesktopPetOverlayBridgeInvocation[]> {
  return page.evaluate((key) => {
    const target = window as DesktopPetOverlayProbeWindow;
    return [...(target[key] ?? [])];
  }, desktopPetOverlayBridgeInvocationKey);
}
