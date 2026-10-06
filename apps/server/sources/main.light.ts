import { runLightServerMain } from '@/flavors/light/main';
import { readSharedQaSchemaMismatchDiagnostic } from '@/storage/prismaErrors';

void runLightServerMain().catch((error) => {
    console.error(readSharedQaSchemaMismatchDiagnostic(error) ?? error);
    process.exit(1);
});
