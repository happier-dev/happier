Qwen plugin package.

This package owns the Qwen Agent definition and contributes it through the
single plugin `activate(api)` ABI. The centralized host runtime owns session and
turn lifecycle; generated CLI/UI projections consume the Agent contribution.
