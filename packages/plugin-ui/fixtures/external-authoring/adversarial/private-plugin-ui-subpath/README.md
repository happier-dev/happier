# Private Plugin UI Subpath Adversary

This package is a bounded external-authoring conformance adversary. It tries to
load a non-public `plugin-ui` source path through the public package boundary and
passes only when the package export owner rejects that path. It is not a
production fallback or documentation example.
