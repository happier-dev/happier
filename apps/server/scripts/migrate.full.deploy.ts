import { runPrismaCli, resolveServerWorkspaceRoot } from "./prismaCli";

async function main() {
    const env: NodeJS.ProcessEnv = { ...process.env };
    const serverRoot = resolveServerWorkspaceRoot(import.meta.url);
    await runPrismaCli({
        serverRoot,
        args: ["migrate", "deploy", "--schema", "prisma/schema.prisma"],
        env,
    });
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
