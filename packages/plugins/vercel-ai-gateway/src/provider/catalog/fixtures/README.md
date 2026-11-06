# Gateway catalog fixture

Reconstructed on 2026-10-25 from Vercel's documented JSON shape, not captured from a tenant or asserted as current model availability. Model values exercise metadata and exclusion contracts, including authenticated virtual-model identifiers.

- https://vercel.com/docs/ai-gateway/sdks-and-apis/rest-api#list-models
- https://vercel.com/docs/ai-gateway/models-and-providers/reasoning#discover-model-reasoning-support

The public catalog has `object: "list"` and `data` rows with `id`, `name`, `type`, `context_window`, `tags`, and optional `reasoning_options`. Missing controls mean unspecified support. The catalog advertises no structured reasoning default.
