import Fastify from "fastify";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";

export function createAuthenticatedTestApp() {
    const app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as any;

    typed.decorate("authenticate", async (request: any, reply: any) => {
        const userId = request.headers["x-test-user-id"];
        if (typeof userId !== "string" || !userId) {
            return reply.code(401).send({ error: "Unauthorized" });
        }
        request.userId = userId;
    });

    return typed;
}

export async function withAuthenticatedTestApp(
    registerRoutes: (app: any) => void,
    run: (app: any) => Promise<void>,
): Promise<void> {
    const app = createAuthenticatedTestApp();
    registerRoutes(app);
    await app.ready();
    try {
        await run(app);
    } finally {
        await app.close();
    }
}
