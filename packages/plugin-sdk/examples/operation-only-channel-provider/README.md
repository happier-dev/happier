# Operation-Only Channels Provider

This is the minimal maintained public cross-plugin reference. It consumes
the maintained `@happier-dev/channels-protocol/v1` provider contract and binds
the required roles to Actions owned by this plugin.

It does not declare a target, descriptor, renderer, or UI. `happier.channels`
and its `providers` contribution point are owned by Channels; the `acme`
contribution id below is only this plugin's opaque local id.

For the advanced public target-owned descriptor and embedded-surface shape, see
the `action-contract-producer` and `action-contract-consumer` pair. External and
bundled plugins use the same public contracts; the capability matrix separately
records source availability and loaded proof. Do not use that pair as the
beginner template.

Use the normal managed author loop from the generated scaffold:

```sh
happier plugins dev build .
happier plugins test .
happier plugins dev
```
