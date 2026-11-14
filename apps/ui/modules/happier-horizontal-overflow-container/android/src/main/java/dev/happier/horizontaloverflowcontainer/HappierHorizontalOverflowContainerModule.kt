package dev.happier.horizontaloverflowcontainer

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class HappierHorizontalOverflowContainerModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("HappierHorizontalOverflowContainer")
    View(HappierHorizontalOverflowContainerView::class) {}
  }
}
