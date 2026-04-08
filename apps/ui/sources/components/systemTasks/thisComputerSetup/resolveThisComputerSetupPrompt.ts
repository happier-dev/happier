import type { SystemTaskJsonObject } from '@happier-dev/protocol';

import { readLatestSystemTaskPrompt, type SystemTaskPromptEnvelope } from '../prompts/readLatestSystemTaskPrompt';
import type { SystemTaskRunState } from '../types';

export type ThisComputerSetupPrompt =
    | Readonly<{
        kind: 'releaseChannel.switchDefaultForSetup';
        message: string;
        targetReleaseChannel: string;
        currentDefaultReleaseChannel: string | null;
        targetServerUrl: string | null;
        managedReleaseChannels: ReadonlyArray<Readonly<{
            releaseChannel: string;
            label: string;
            version: string | null;
            installationId: string;
            installationPath: string;
            invokerName: string;
            isDefault: boolean;
            onPath: boolean;
        }>>;
    }>
    | Readonly<{
        kind: 'daemon.replaceLocalBackgroundServices';
        message: string;
        targetReleaseChannel: string | null;
        targetServerUrl: string | null;
        services: ReadonlyArray<Readonly<{
            label: string;
            releaseChannel: string | null;
            targetMode: string | null;
            running: boolean;
            serverUrl: string | null;
        }>>;
    }>;

function readTrimmedString(record: SystemTaskJsonObject, key: string): string | null {
    const value = record[key];
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export function resolveThisComputerSetupPrompt(
    promptOrSnapshot: SystemTaskPromptEnvelope | SystemTaskRunState | null,
): ThisComputerSetupPrompt | null {
    const prompt = promptOrSnapshot && 'events' in promptOrSnapshot
        ? readLatestSystemTaskPrompt(promptOrSnapshot)
        : promptOrSnapshot;
    if (!prompt) {
        return null;
    }

    const record = prompt.data as SystemTaskJsonObject & { kind?: unknown };
    if (prompt.kind === 'releaseChannel.switchDefaultForSetup') {
        const targetReleaseChannel = readTrimmedString(record, 'targetReleaseChannel');
        if (!targetReleaseChannel) {
            return null;
        }
        const managedReleaseChannelsRaw = Array.isArray(record.managedReleaseChannels)
            ? record.managedReleaseChannels
            : [];
        const managedReleaseChannels = managedReleaseChannelsRaw.flatMap((entry) => {
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
                return [];
            }
            const item = entry as SystemTaskJsonObject;
            const releaseChannel = readTrimmedString(item, 'releaseChannel');
            const label = readTrimmedString(item, 'label');
            const installationId = readTrimmedString(item, 'installationId');
            const installationPath = readTrimmedString(item, 'installationPath');
            const invokerName = readTrimmedString(item, 'invokerName');
            if (!releaseChannel || !label || !installationId || !installationPath || !invokerName) {
                return [];
            }
            return [{
                releaseChannel,
                label,
                version: readTrimmedString(item, 'version'),
                installationId,
                installationPath,
                invokerName,
                isDefault: item.isDefault === true,
                onPath: item.onPath === true,
            }];
        });

        return {
            kind: prompt.kind,
            message: prompt.message,
            targetReleaseChannel,
            currentDefaultReleaseChannel: readTrimmedString(record, 'currentDefaultReleaseChannel'),
            targetServerUrl: readTrimmedString(record, 'targetServerUrl'),
            managedReleaseChannels,
        };
    }

    if (prompt.kind === 'daemon.replaceLocalBackgroundServices') {
        const servicesRaw = Array.isArray(record.services) ? record.services : [];
        const services = servicesRaw.flatMap((entry) => {
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
                return [];
            }
            const item = entry as SystemTaskJsonObject;
            const label = readTrimmedString(item, 'label');
            if (!label) {
                return [];
            }
            return [{
                label,
                releaseChannel: readTrimmedString(item, 'releaseChannel'),
                targetMode: readTrimmedString(item, 'targetMode'),
                running: item.running === true,
                serverUrl: readTrimmedString(item, 'serverUrl'),
            }];
        });

        return {
            kind: prompt.kind,
            message: prompt.message,
            targetReleaseChannel: readTrimmedString(record, 'targetReleaseChannel'),
            targetServerUrl: readTrimmedString(record, 'targetServerUrl'),
            services,
        };
    }

    return null;
}
