import { runLightServerMain } from '@/flavors/light/main';

void runLightServerMain().catch((error) => {
    console.error(error);
    process.exit(1);
});
