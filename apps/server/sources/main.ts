import 'reflect-metadata';
import { startServer } from '@/startServer';
import { registerProcessHandlers } from '@/utils/process/processHandlers';

registerProcessHandlers();

startServer('full').catch((e) => {
    console.error(e);
    process.exit(1);
}).then(() => {
    process.exit(0);
});
