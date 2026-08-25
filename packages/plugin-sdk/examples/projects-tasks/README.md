# Projects and Tasks Plugin Example

This maintained, public-only package demonstrates an Account Collection surface:
the cold manifest declares `projects`, `tasks`, and the bounded
`tasks.openByProject` UI query. The React Native surface consumes the mounted
Data client through `@happier-dev/plugin-ui/data`; its declarative fallback
binds that same admitted query through the host Collection List.

It is not an ordinary authoring template. Start a new plugin with
`happier plugins create` and declare ordinary contributions through
`definePlugin(...)`; the canonical author build projects its cold manifest.

The surface asks for an existing Project ID, presents only the query's declared
fields, and rereads a Task before marking it complete with that row's current
revision. Its public virtualized List keeps a last-known-good page visible with
error feedback when a refresh fails. Query paging, Account-change invalidation,
cancellation, freshness, and Account lifetime remain owned by the host Data
service.

When the native renderer is unavailable, the declarative fallback displays the
open tasks for its bounded `project-a` binding. It uses the same query fields;
the host Collection List owns its accessible loading, empty, and retryable
last-known-good error states without a daemon tunnel or a second query path.

`pluginUiBuild.ts` declares the standard web, iOS, and Android targets. The
SDK build owner derives its operation-local Vite and Re.Pack configuration; no
package-root bundler config or generated artifact is checked in. This source
package does not by itself prove empty-workspace installation,
daemon-offline behavior, or device rendering; those are separate loaded-runtime
validation gates on the existing development stack.
