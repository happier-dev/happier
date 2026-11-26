#!/bin/sh
# TEMPORARY lane scratch: prints short git status. Delete after this lane.
git --no-optional-locks status --porcelain=v1 -b
