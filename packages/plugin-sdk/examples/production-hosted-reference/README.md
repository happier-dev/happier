# Production Hosted Review Reference

This is the hosted-web member of the production reference portfolio. It is a
complete external plugin package, not a beginner template: its
`definePlugin(...)` definition declares one safe Action, a packaged review
guide, one hosted artifact, and a declarative unavailable fallback. The
canonical author build derives the cold manifest and verifies parity with that
definition.

It is not an ordinary authoring template. Start a new plugin with
`happier plugins create` and declare ordinary contributions through
`definePlugin(...)`; the canonical author build projects its cold manifest.

The mounted browser entry uses only the public hosted client. It waits for the
host-issued render context, reads the packaged Resource through `readResource`,
watches accepted context updates, runs the declared Action, renders operation
errors, and changes to an offline state when the host retirement signal aborts.
It renders the host-issued local `subPath` and only the presence of launch input
without parsing or disclosing that payload; its history button delegates route
construction back through `openSurface`. The retry control reuses the same
mount-bound API and signal; it does not create a second bridge, poller, URL
parser, or cache.

The derived cold manifest binds this package's packaged PNG to
`brand.iconResourceId`.
The existing host brand presentation owns byte validation and its neutral
fallback; this browser artifact neither fetches a remote image nor introduces
an image/fallback pipeline.

This reference is the production-shaped positive consumer for hosted authoring.
Its emitted graph is checked through the incumbent resolver, while browser and
native-frame rows run against the observed current source and loaded development
runtime. No separate release representation is created for feature QA.

Run the package through the canonical author owners:

```bash
happier plugins dev typecheck .
happier plugins dev build .
happier plugins test .
happier plugins dev
```

Exercise browser/frame and activation lifecycle evidence through the existing
loaded development stack.
