# Operation-Only Channels Provider

This is the minimal external-author-supported cross-plugin example. It consumes
the maintained `@happier-dev/channels-protocol/v1` provider contract and binds
the required roles to Actions owned by this plugin.

It does not declare a target, descriptor, renderer, or UI. `happier.channels`
and its `providers` contribution point are owned by Channels; the `acme`
contribution id below is only this plugin's opaque local id.

For a first-party Preview product that also needs a target-owned descriptor and
embedded surface, see the advanced `action-contract-producer` and
`action-contract-consumer` pair. Do not use that pair as a beginner external
authoring template.

Use the normal managed author loop from the generated scaffold:

```sh
happier plugins dev build .
happier plugins test .
happier plugins dev
```
