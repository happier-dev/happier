import 'reflect-metadata';
import 'dotenv/config';

import { startServer } from '@/startServer';
import { registerProcessHandlers } from '@/utils/process/processHandlers';

registerProcessHandlers();

startServer('light').catch((e) => {
    console.error(e);
    process.exit(1);
});
