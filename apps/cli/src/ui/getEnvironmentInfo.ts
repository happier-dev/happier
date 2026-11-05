import { configuration } from '@/configuration';
import { redactCliApiTokenArgv } from '@/auth/cliApiToken';

export interface EnvironmentInfo {
    PWD: string | undefined;
    HAPPIER_HOME_DIR: string | undefined;
    HAPPIER_SERVER_URL: string | undefined;
    HAPPIER_PROJECT_ROOT: string | undefined;
    DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING: string | undefined;
    NODE_ENV: string | undefined;
    DEBUG: string | undefined;
    workingDirectory: string;
    processArgv: string[];
    happyDir: string;
    serverUrl: string;
    logsDir: string;
    processPid: number;
    nodeVersion: string;
    platform: NodeJS.Platform;
    arch: string;
    user: string | undefined;
    home: string | undefined;
    shell: string | undefined;
    terminal: string | undefined;
}

/** Environment logging is also used by startup, before diagnostic commands are needed. */
export function getEnvironmentInfo(): EnvironmentInfo {
    return {
        PWD: process.env.PWD,
        HAPPIER_HOME_DIR: process.env.HAPPIER_HOME_DIR,
        HAPPIER_SERVER_URL: process.env.HAPPIER_SERVER_URL,
        HAPPIER_PROJECT_ROOT: process.env.HAPPIER_PROJECT_ROOT,
        DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING: process.env.DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING,
        NODE_ENV: process.env.NODE_ENV,
        DEBUG: process.env.DEBUG,
        workingDirectory: process.cwd(),
        processArgv: redactCliApiTokenArgv(process.argv),
        happyDir: configuration?.happyHomeDir,
        serverUrl: configuration?.serverUrl,
        logsDir: configuration?.logsDir,
        processPid: process.pid,
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
        user: process.env.USER,
        home: process.env.HOME,
        shell: process.env.SHELL,
        terminal: process.env.TERM,
    };
}
