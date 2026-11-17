import { resolveManagedCliReleaseChannelSync } from '@happier-dev/cli-common/firstPartyRuntime';
import type { PublicReleaseRingLabel } from '@happier-dev/release-runtime/releaseRings';
import { DEPLOYED_TELEMETRY_PORT_ENV, readDeployedTelemetryPort } from '@/deployments/telemetry/collectorHost';
import { isNativeDefinitionRecord as record } from '@/workspaces/projectSetup/nativePackageScripts';

export type NativeComposeAppEnrollment = Readonly<{
    serviceName: string;
    port: number;
    homeDir: string;
    happyHomeDir: string;
    releaseChannel: PublicReleaseRingLabel;
}>;

/** Host-private enrollment coordinates come from the one resolved native model. */
export function projectNativeComposeAppEnrollments(services: Readonly<Record<string, unknown>>, refuse: () => never):
    readonly NativeComposeAppEnrollment[] | undefined {
    const declarations: NativeComposeAppEnrollment[] = [];
    for (const [serviceName, service] of Object.entries(services)) {
        if (!record(service) || !record(service.environment) || !(DEPLOYED_TELEMETRY_PORT_ENV in service.environment)) continue;
        const environment = service.environment;
        if (typeof environment[DEPLOYED_TELEMETRY_PORT_ENV] !== 'string'
            || typeof environment.HOME !== 'string' || !environment.HOME
            || typeof environment.HAPPIER_HOME_DIR !== 'string' || !environment.HAPPIER_HOME_DIR) return refuse();
        const stringEnvironment = Object.fromEntries(Object.entries(environment)
            .flatMap(([key, value]) => typeof value === 'string' ? [[key, value] as const] : []));
        let port: number | undefined;
        try { port = readDeployedTelemetryPort(stringEnvironment); } catch { return refuse(); }
        if (port === undefined) return refuse();
        declarations.push({ serviceName, port, homeDir: environment.HOME, happyHomeDir: environment.HAPPIER_HOME_DIR,
            releaseChannel: resolveManagedCliReleaseChannelSync({ processEnv: stringEnvironment, execPath: '', argv0: '',
                markerFallback: 'never' }).label });
    }
    return declarations.length ? declarations : undefined;
}
