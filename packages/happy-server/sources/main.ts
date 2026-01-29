import { startServer } from '@/startServer';
import { registerProcessHandlers } from '@/utils/processHandlers';

registerProcessHandlers();

startServer('full').catch((e) => {
    console.error(e);
    process.exit(1);
}).then(() => {
    process.exit(0);
});
