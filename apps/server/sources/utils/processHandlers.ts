import { log } from '@/utils/log';
import { initiateShutdown } from './shutdown';

export function registerProcessHandlers(): void {
    if ((globalThis as any).__HAPPY_PROCESS_HANDLERS_INSTALLED) {
        return;
    }
    (globalThis as any).__HAPPY_PROCESS_HANDLERS_INSTALLED = true;

    // Process-level error handling
    process.on('uncaughtException', (error) => {
        void handleFatal('uncaughtException', error);
    });

    process.on('unhandledRejection', (reason, promise) => {
        void handleFatal('unhandledRejection', reason, promise);
    });

    process.on('warning', (warning) => {
        log({
            module: 'process-warning',
            level: 'warn',
            name: warning.name,
            stack: warning.stack
        }, `Process Warning: ${warning.message}`);
    });

    // Log when the process is about to exit
    process.on('exit', (code) => {
        if (code !== 0) {
            log({
                module: 'process-exit',
                level: 'error',
                exitCode: code
            }, `Process exiting with code: ${code}`);
        } else {
            log({
                module: 'process-exit',
                level: 'info',
                exitCode: code
            }, 'Process exiting normally');
        }
    });
}

let fatalInProgress = false;
async function handleFatal(type: 'uncaughtException' | 'unhandledRejection', reason: unknown, promise?: unknown): Promise<void> {
    if (fatalInProgress) {
        // Avoid silently dropping secondary fatal events (can happen during cascading failures).
        log(
            {
                module: 'process-error',
                level: 'warn',
                suppressed: true,
                fatalType: type,
                reason: String(reason),
                ...(promise ? { promise: String(promise) } : {}),
            },
            'Suppressed fatal event (already handling a fatal)',
        );
        return;
    }
    fatalInProgress = true;

    const errorMsg = reason instanceof Error ? reason.message : String(reason);
    const errorStack = reason instanceof Error ? reason.stack : undefined;
    const errorName = reason instanceof Error ? reason.name : undefined;

    log(
        {
            module: 'process-error',
            level: 'error',
            stack: errorStack,
            name: errorName,
            reason: String(reason),
            ...(promise ? { promise: String(promise) } : {}),
        },
        type === 'uncaughtException' ? `Uncaught Exception: ${errorMsg}` : `Unhandled Rejection: ${errorMsg}`,
    );

    if (type === 'uncaughtException') {
        console.error('Uncaught Exception:', reason);
    } else {
        console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    }

    process.exitCode = 1;

    try {
        await initiateShutdown(`fatal:${type}`);
    } catch (e) {
        console.error('Fatal shutdown handler failure:', e);
    }

    // In tests we never want to hard-exit the runner.
    const shouldExit =
        process.env.HAPPY_EXIT_ON_FATAL !== '0' &&
        process.env.HAPPY_EXIT_ON_FATAL !== 'false' &&
        process.env.NODE_ENV !== 'test';

    if (shouldExit) {
        process.exit(1);
        return;
    }

    // In non-exiting modes (tests / HAPPY_EXIT_ON_FATAL=0), allow subsequent fatal handlers to run.
    fatalInProgress = false;
}
