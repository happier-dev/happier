import type { BrowserContextRoutes } from '@/daemon/browser/context/routes';
import type { BrowserDaemonControlRoutes } from '@/daemon/browser/control/routes';
import type { BrowserDaemonViewDiscovery } from '@/daemon/browser/control/viewDiscovery';
import type { BrowserDiagnosticsRoutes } from '@/daemon/browser/diagnostics/routes';
import type { BrowserRecordingRoutes } from '@/daemon/browser/recording/routes';
import type { ComputerRoutes } from '@/daemon/computer/routes';
import type { SimulatorPreviewRoutes } from '@/daemon/devices/simulator/previewRoutes.types';

/**
 * What the active `devices` Machine role publishes for the Machine transport: the routes behind its
 * RPC families (registered as one owned set) and the reads the core live-stream admission makes.
 * Type-only, so machine core never loads the role's code through it.
 */
export type DevicesRoleMachineRoutes = Readonly<{
  resolveComputer?: () => ComputerRoutes | null;
  browserControl?: BrowserDaemonControlRoutes;
  browserViewDiscovery?: BrowserDaemonViewDiscovery;
  browserContext?: BrowserContextRoutes;
  browserDiagnostics?: BrowserDiagnosticsRoutes;
  browserRecording?: BrowserRecordingRoutes;
  simulatorPreview?: SimulatorPreviewRoutes;
}>;
