# Happier Docs

This package builds Happier's published Fumadocs site for users, operators, self-hosters, provider users, and public contributors.

- Published content: `content/docs/**`
- Documentation application: `src/**`
- Content configuration: `source.config.ts`
- Internal technical and product-architecture documentation: `../../docs/**`

Follow `AGENTS.md` before changing content or the documentation application.

## Commands

From the repository root:

```bash
yarn --cwd apps/docs dev
yarn --cwd apps/docs types:check
yarn --cwd apps/docs build
```

Use `types:check` for MDX, schema, generated-content, or TypeScript changes. Run the production build when routing, navigation, generation, or rendering can be affected.
