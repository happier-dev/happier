import { logger } from '@/ui/logger';

import type { PluginInvocationLogSink } from './logger';

export function createFilePluginInvocationLogSink(): PluginInvocationLogSink {
    return Object.freeze({
        write(record) {
            logger.appendPluginInvocationLogRecord(record);
        },
    });
}
