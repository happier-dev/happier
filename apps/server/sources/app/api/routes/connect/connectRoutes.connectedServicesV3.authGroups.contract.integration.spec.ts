import Fastify from "fastify";
import type { FastifyReply, FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";
import {
    serializerCompiler,
    validatorCompiler,
    ZodTypeProvider,
} from "fastify-type-provider-zod";

import { connectConnectedServicesV3Routes } from "./connectRoutes.connectedServicesV3";

describe("connect V3 auth-group route contraction", () => {
    it("does not register the unreleased V3 auth-group selection route", async () => {
        const app = Fastify();
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        const typed = app.withTypeProvider<ZodTypeProvider>();
        typed.decorate("authenticate", async (_request: FastifyRequest, reply: FastifyReply) => (
            reply.code(401).send({ error: "Unauthorized" })
        ));
        connectConnectedServicesV3Routes(typed);
        await typed.ready();

        try {
            const response = await typed.inject({
                method: "GET",
                url: "/v3/connect/openai-codex/groups",
            });

            expect(response.statusCode).toBe(404);
        } finally {
            await typed.close();
        }
    });
});
