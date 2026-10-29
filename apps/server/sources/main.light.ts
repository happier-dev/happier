import './configureZodLocale';
import { runLightServerMain } from '@/flavors/light/main';
import { readSharedQaSchemaMismatchDiagnostic } from '@/storage/prismaErrors';

void runLightServerMain()
    .catch((error) => {
        console.error(readSharedQaSchemaMismatchDiagnostic(error) ?? error);
        process.exit(1);
    })
    .then(() => {
        // Shutdown hooks have finished; remaining handles must not defer the
        // normal exit that flushes Node's CPU profile. Preserve command refusals.
        process.exit(process.exitCode ?? 0);
    });
