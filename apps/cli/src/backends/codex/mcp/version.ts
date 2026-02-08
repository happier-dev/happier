import { execFileSync } from 'child_process';

import { logger } from '@/ui/logger';

export interface CodexVersionInfo {
    raw: string | null;
    parsed: boolean;
    major: number;
    minor: number;
    patch: number;
    prereleaseTag?: string;
    prereleaseNum?: number;
}

export type CodexVersionTarget = Pick<
    CodexVersionInfo,
    'major' | 'minor' | 'patch' | 'prereleaseTag' | 'prereleaseNum'
>;

export type ElicitationResponseStyle = 'decision' | 'both';

export const MCP_SERVER_MIN_VERSION: CodexVersionTarget = {
    major: 0,
    minor: 43,
    patch: 0,
    prereleaseTag: 'alpha',
    prereleaseNum: 5,
};

export const ELICITATION_DECISION_MAX_VERSION: CodexVersionTarget = {
    major: 0,
    minor: 77,
    patch: 0,
};

const cachedCodexVersionInfoByCommand = new Map<string, CodexVersionInfo>();

export function getCodexVersionInfo(codexCommand: string): CodexVersionInfo {
    const cached = cachedCodexVersionInfoByCommand.get(codexCommand);
    if (cached) return cached;

    try {
        const raw = execFileSync(codexCommand, ['--version'], { encoding: 'utf8' }).trim();
        const match = raw.match(/(?:codex(?:-cli)?)\s+v?(\d+)\.(\d+)\.(\d+)(?:-([a-z]+)\.(\d+))?/i)
            ?? raw.match(/\b(\d+)\.(\d+)\.(\d+)(?:-([a-z]+)\.(\d+))?\b/);
        if (!match) {
            const info: CodexVersionInfo = {
                raw,
                parsed: false,
                major: 0,
                minor: 0,
                patch: 0,
            };
            cachedCodexVersionInfoByCommand.set(codexCommand, info);
            return info;
        }

        const info: CodexVersionInfo = {
            raw,
            parsed: true,
            major: Number(match[1]),
            minor: Number(match[2]),
            patch: Number(match[3]),
            prereleaseTag: match[4],
            prereleaseNum: match[5] ? Number(match[5]) : undefined,
        };
        cachedCodexVersionInfoByCommand.set(codexCommand, info);
        return info;
    } catch (error) {
        logger.debug(`[CodexMCP] Error detecting codex version for ${codexCommand}:`, error);
        const info: CodexVersionInfo = {
            raw: null,
            parsed: false,
            major: 0,
            minor: 0,
            patch: 0,
        };
        cachedCodexVersionInfoByCommand.set(codexCommand, info);
        return info;
    }
}

export function compareVersions(info: CodexVersionInfo, target: CodexVersionTarget): number {
    if (info.major !== target.major) return info.major - target.major;
    if (info.minor !== target.minor) return info.minor - target.minor;
    if (info.patch !== target.patch) return info.patch - target.patch;

    const infoTag = info.prereleaseTag;
    const targetTag = target.prereleaseTag;
    if (!infoTag && !targetTag) return 0;
    if (!infoTag && targetTag) return 1;
    if (infoTag && !targetTag) return -1;
    if (!infoTag || !targetTag) return 0;
    if (infoTag !== targetTag) return infoTag.localeCompare(targetTag);

    const infoNum = info.prereleaseNum ?? 0;
    const targetNum = target.prereleaseNum ?? 0;
    return infoNum - targetNum;
}

export function isVersionAtLeast(info: CodexVersionInfo, target: CodexVersionTarget): boolean {
    if (!info.parsed) return false;
    return compareVersions(info, target) >= 0;
}

export function isVersionAtMost(info: CodexVersionInfo, target: CodexVersionTarget): boolean {
    if (!info.parsed) return false;
    return compareVersions(info, target) <= 0;
}

export function getElicitationResponseStyle(info: CodexVersionInfo): ElicitationResponseStyle {
    const override = process.env.HAPPIER_CODEX_ELICITATION_STYLE?.toLowerCase();
    if (override === 'decision' || override === 'both') {
        return override;
    }

    if (!info.parsed) return 'both';
    return isVersionAtMost(info, ELICITATION_DECISION_MAX_VERSION) ? 'decision' : 'both';
}

export function getCodexMcpCommand(codexCommand: string): string {
    const info = getCodexVersionInfo(codexCommand);
    if (!info.parsed) return 'mcp-server';
    return isVersionAtLeast(info, MCP_SERVER_MIN_VERSION) ? 'mcp-server' : 'mcp';
}

